# VibeCraftHub

Plataforma self-hosted para que los empleados de una empresa publiquen aplicaciones web internas de forma autónoma y segura, sin abrir la puerta al shadow IT.

- Los empleados publican apps **100% estáticas** (html, js, css, json, xml + sqlite opcional) sin intervención de TI.
- Todo bundle pasa por un **pipeline de revisión** (estructura, reglas de seguridad, política de severidades) antes de publicarse. Un rechazo entrega un reporte detallado con archivo, línea y corrección sugerida.
- **Historial completo e inmutable** de cada intento de publicación, exitoso o rechazado.
- Apps en **subdominio aislado** con CSP estricta y sesión obligatoria: la app nunca puede invocar la API de la plataforma.
- Despliegue con **un solo `podman compose up`** en una VM on-premise (docker compose también funciona).

## Arquitectura

```
apps/
  api/        Fastify + TypeScript: auth, apps, versiones, pipeline, historial
  portal/     React + Vite: catálogo, wizard de publicación, panel admin
  gateway/    Caddy: TLS, sirve bundles con forward_auth + CSP
packages/
  shared/     Tipos compartidos (findings, manifest, policy)
  scanner/    Reglas de análisis estático (lib pura, testeable)
infra/
  docker-compose.yml
```

- **PostgreSQL** guarda la plataforma (usuarios, apps, versiones, intentos).
- Los bundles viven en un **volumen** inmutable por versión; un symlink `active` apunta a la versión vigente.
- En desarrollo sin docker, el API usa **PGlite** (Postgres embebido) y sirve los bundles directamente.

## Desarrollo

Requisitos: Node 24+, pnpm 10.

```bash
pnpm install
pnpm build          # comparte shared y scanner, api y portal
pnpm test:scanner   # pruebas del pipeline de revisión

# Terminal 1: API en :3000 (PGlite embebida, sin docker)
pnpm dev:api

# Terminal 2: portal en :5173 (proxy /api y /bundles al API)
pnpm dev:portal
```

Abre http://localhost:5173. El **primer usuario registrado es admin**. Desde Admin → Usuarios crea cuentas `developer` para publicar.

> En desarrollo los bundles se sirven desde el mismo origen que la API (`/bundles/{slug}/`), así que el aislamiento por subdominio de producción **no aplica en dev**. Verifica el aislamiento en el despliegue compose.

### Variables del API (dev)

| Variable | Default | Descripción |
|---|---|---|
| `PORT` | `3000` | Puerto del API |
| `DATABASE_URL` | *(vacío)* | Si se define, usa Postgres; si no, PGlite embebida |
| `BUNDLES_DIR` | `data/bundles` | Volumen de bundles |
| `COOKIE_DOMAIN` | *(vacío)* | Domain de la cookie (ej `.localhost` para cubrir subdominios) |
| `COOKIE_SECURE` | `0` | `1` para HTTPS |
| `APPS_URL_TEMPLATE` | `http://localhost:3000/bundles/{slug}/` | Plantilla de URL pública de las apps |

## Despliegue en producción (podman)

Requisitos: podman 5+ y `podman-compose` (o docker-compose, el wrapper `podman compose` usa cualquiera de los dos).

```bash
cd infra
podman compose up -d --build
# equivalente: podman-compose up -d --build
```

Servicios: `gateway` (Caddy, únicos puertos expuestos), `api`, `postgres`.

- **Rootless**: el gateway publica en **8080 (HTTP) y 8443 (HTTPS)** porque un usuario sin privilegios no puede bind 80/443. Abre https://localhost:8443. Para puertos estándar: corre rootful (`sudo podman compose up -d --build`) o baja `net.ipv4.ip_unprivileged_port_start=80`.
- Las imágenes base están **totalmente calificadas** (`docker.io/library/...`): podman no resuelve shortnames sin interacción.
- Los datos viven en volúmenes nombrados de podman (`podman volume ls`): bundles, pgdata, certs de Caddy.
- Acepta el certificado de la CA interna de Caddy la primera vez (o instala tu propia CA).
- Registra el admin, crea usuarios, publica apps.
- Requisito de red para dominio real: DNS interno con wildcard `*.apps.empresa.com` apuntando a la VM.

### Dominio real (empresa.com)

Ajusta en `infra/docker-compose.yml`:

| Variable | Valor para empresa.com |
|---|---|
| `PORTAL_HOST` | `portal.empresa.com` |
| `APPS_WILDCARD` | `*.apps.empresa.com` |
| `APPS_ROOT_TEMPLATE` | `/srv/bundles/{labels.3}/active` |
| `APPS_URL_TEMPLATE` | `https://{slug}.apps.empresa.com` |
| `COOKIE_DOMAIN` | `.empresa.com` |

Requisito: portal y apps deben compartir **dominio base** (mismo sitio registrable) para que la cookie de sesión funcione en el iframe.

### Variables del compose

| Variable | Default | Descripción |
|---|---|---|
| `POSTGRES_PASSWORD` | `vch-cambia` | **Cámbiala** antes del primer arranque |
| `PORTAL_HOST` | `localhost` | Host del portal |
| `APPS_WILDCARD` | `*.apps.localhost` | Wildcard de las apps |
| `COOKIE_DOMAIN` | `.localhost` | Domain de la cookie de sesión |
| `COOKIE_SECURE` | `1` | `0` solo si sirves por HTTP plano en LAN |

> Si mapeas el gateway a 80/443 reales, quita el puerto `:8443` de `APPS_URL_TEMPLATE` en `infra/docker-compose.yml` y ajusta `PORTAL_HOST`.

### Topología local: `*.apps.localhost` y la cookie

`localhost` figura en la Public Suffix List: curl y navegadores estrictos convierten `Domain=.localhost` en cookie **de host único**, así que la sesión no llega a los subdominios `*.apps.localhost` (el gateway responde 401 por `forward_auth`). El portal sí funciona; solo falla el acceso a las apps por subdominio.

Para probar el aislamiento completo en local usa un dominio que no esté en la PSL:

1. Entradas en `/etc/hosts` (o dnsmasq con `address=/.apps.vch.local/127.0.0.1`):

   ```
   127.0.0.1 portal.vch.local
   127.0.0.1 miapp.apps.vch.local   # una por app, o dnsmasq wildcard
   ```

2. En `infra/docker-compose.yml`: `PORTAL_HOST=portal.vch.local`, `APPS_WILDCARD=*.apps.vch.local`, `COOKIE_DOMAIN=.vch.local`, `APPS_URL_TEMPLATE=https://{slug}.apps.vch.local:8443`.

3. Acepta/instala la CA interna de Caddy en el navegador.

Con un dominio real (`empresa.com`) no aplica: no está en la PSL y `Domain=.empresa.com` cubre portal y apps sin pasos extra.

## Formato del bundle

Zip con un `app.json` obligatorio en la raíz:

```json
{
  "name": "inventario",
  "version": "1.2.0",
  "entrypoint": "index.html",
  "description": "Control de inventario de oficina",
  "database": { "file": "data.sqlite", "seed": true },
  "externalDomains": []
}
```

- Extensiones permitidas: `html`, `js`, `css`, `json`, `xml`, `sqlite`. Cualquier otra cosa rechaza la publicación.
- `version` es semver y no puede repetirse por app.
- `database` es opcional: si viene, el `.sqlite` se valida (encabezado + `integrity_check`) y queda almacenado inmutable con la versión. En v1 la plataforma lo expondrá como base compartida vía data gateway; hoy se valida y archiva.
- Límites configurables por el admin (política): 20 MB y 500 archivos por defecto.

## Pipeline de revisión

1. **Estructura**: zip válido, sin zip-slip, manifest válido, extensiones permitidas, sin binarios disfrazados, límites.
2. **Reglas estáticas** con severidad: `eval`/`new Function` y secrets embebidos (crítica); `innerHTML`, `document.write`, scripts/CSS/iframes remotos, WebSockets (alta); `fetch`/XHR externos, service workers, imágenes remotas (media); handlers inline, `target=_blank` (baja).
3. **Política**: el admin define qué severidades bloquean (por defecto crítica y alta).
4. **Resultado**: rechazo con reporte detallado (regla, archivo, línea, snippet, corrección sugerida) o publicación de versión inmutable.
5. **Historial**: todo intento queda registrado con sus hallazgos completos.

Defensa en profundidad en runtime: subdominio por app + `forward_auth` (sesión obligatoria) + CSP `default-src 'self'` + iframe `sandbox`. Aunque una regla dejara pasar algo, el navegador lo bloquea en runtime.

## Roadmap

1. **MVP** (este repo): auth local, publicación con pipeline, catálogo, historial, panel admin.
2. **v1**: data gateway + SDK (SQLite compartida por app), apps privadas con allowlist, conector LDAP/AD.
3. **v2**: revisión con LLM (OpenAI-compatible/Anthropic, local o cloud), allowlist de dominios externos, rollback UI, métricas, export de auditoría.

## Licencia

Ver [LICENSE](LICENSE).
