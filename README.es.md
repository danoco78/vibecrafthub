# VibeCraftHub

[English](README.md) | **Español**

![Release](https://img.shields.io/badge/release-v1.0.0-4f8cff)
![License](https://img.shields.io/github/license/danoco78/vibecrafthub)
![Node](https://img.shields.io/badge/node-%E2%89%A524-339933)
![Podman](https://img.shields.io/badge/podman-%E2%89%A55-8930cb)
![Tests](https://img.shields.io/badge/tests-134%20passing-34c98e)
![Idioma](https://img.shields.io/badge/docs-espa%C3%B1ol-f0b429)

**Plataforma self-hosted para que los empleados de una empresa publiquen aplicaciones web internas de forma autónoma y segura** — sin tickets de TI, sin shadow IT, sin abrir puertos en PCs de escritorio.

---

## El problema que resuelve

La IA multiplicó el *shadow IT*: cualquier empleado construye hoy herramientas web útiles en una tarde. Cuando las comparte, su PC pasa de terminal de consumo a **nodo expositor de servicios**, con la infraestructura de la empresa al descubierto.

VibeCraftHub canaliza esa energía por un camino controlado: un catálogo interno donde cualquiera publica sus apps, y un pipeline de seguridad que revisa **cada publicación** antes de que sea visible. TI deja de ser cuello de botella sin perder el control.

## Características

- 📦 **Publicación autónoma** — el empleado sube un zip con su app (html, js, css, json, xml, sqlite opcional); sin intervención de TI.
- 🔑 **Login corporativo LDAP/AD** — los empleados entran con sus credenciales del directorio; la cuenta se crea sola al primer ingreso y el rol sale del mapeo de grupos. El login local queda como rescate.
- 🌐 **Allowlist de dominios externos** — el admin aprueba dominios; las apps que los declaran pasan el pipeline y obtienen CSP para consumirlos.
- 📊 **Métricas de uso** — logins por origen, publicaciones, queries del data gateway y accesos a apps, agregados por día con rangos 24 h/7 d/30 d y export CSV.
- 🗂️ **Export de auditoría** — publicaciones y acciones de administración en CSV o JSON, filtrables por rango de fechas y app.
- 🗄️ **Data gateway: BD SQLite por app** — las apps tienen persistencia real compartida entre sus usuarios vía SDK (`VCH.db`), aislada por completo entre apps, con cuota y límites configurables.
- 🔒 **Apps privadas con allowlist** — el dueño restringe qué usuarios concretos pueden ver y usar cada app; catálogo y subdominio hacen enforcement.
- 🔍 **Pipeline de revisión en 3 etapas** — estructura (zip-slip, extensiones, binarios disfrazados, límites), reglas estáticas con severidades y revisión semántica con LLM (OpenAI-compatible o Anthropic, cloud o local). Cada rechazo entrega un reporte con archivo, línea y corrección sugerida.
- 🗂️ **Catálogo interno** — las apps se sirven en subdominios aislados con TLS, CSP estricta y sesión obligatoria: una app publicada no puede invocar la API de la plataforma (solo su propio namespace `/db/`).
- 🧾 **Auditoría completa** — todo intento de publicación (exitoso o rechazado) queda registrado e inmutable, con hallazgos, proveedor LLM, modelo y caché; las acciones de admin sobre BDs también.
- 👥 **Gestión ligera** — usuarios locales con roles, activación/desactivación, reset de contraseñas, política de severidades bloqueante y límites del gateway configurables.
- 🪄 **Asistente para IA** — un formulario en «Mis apps» genera el prompt exacto para pedirle a cualquier IA la app que el empleado imagina, con las reglas de la plataforma ya integradas.
- 🏗️ **Endurecimiento del pipeline** — el scanner detecta `<script>` inline que la CSP bloquea, referencias a archivos ausentes del zip y uso del SDK sin cargarlo; cada rechazo dice archivo y línea.
- 🐳 **Un solo comando** — `podman compose up -d --build` en una VM: gateway, API y base de datos.

## Arquitectura

```mermaid
flowchart LR
    U["Empleados<br/>(navegador)"] -- "443 TLS · única entrada" --> GW

    subgraph VM["VM on-premise · podman compose"]
        GW["gateway · Caddy<br/>TLS · forward_auth · CSP"]
        API["api · Fastify<br/>auth · pipeline · auditoría"]
        PG[("PostgreSQL<br/>plataforma")]
        V1[("bundles<br/>inmutables")]
    end

    GW -- "/ → portal SPA" --> PT["React"]
    GW -- "{slug}.apps.* → bundle" --> V1
    GW -- "/api/*" --> API
    API --> PG
    API -- "lee/escribe" --> V1
    API -. "revisión LLM" .-> LLM["OpenAI-compatible<br/>o Anthropic"]
```

**Modelo de seguridad en profundidad:**

1. **Pipeline** — nada se publica sin pasar estructura, reglas y política de severidades.
2. **Aislamiento de red** — cada app vive en `*.apps.empresa.com`; `forward_auth` exige sesión antes de servir cualquier asset; el dominio del app no alcanza a la API.
3. **Aislamiento de datos** — una BD SQLite por app, resuelta por el `Host` de la request: una app jamás alcanza los datos de otra, ni siquiera con SQL.
4. **CSP estricta** — `default-src 'self'` por app en iframe sandbox: aunque una regla pasara algo, el navegador lo bloquea en runtime.
5. **Cifrado de credenciales** — contraseñas con Argon2id, sesiones httpOnly + Secure, API keys del LLM nunca expuestas (enmascaradas en el panel).

## Inicio rápido

Requisitos: podman ≥ 5 (o docker) y 2 GB RAM.

```bash
git clone https://github.com/danoco78/vibecrafthub.git
cd vibecrafthub/infra
podman compose up -d --build
```

1. Abre `https://localhost:8443` y acepta el certificado de la CA interna de Caddy.
2. **El primer registro se convierte en admin.** Crea cuentas `developer` desde Admin → Usuarios.
3. Publica tu primera app (ver formato del bundle abajo) y aparecerá en `https://<slug>.apps.localhost:8443`.

Guías completas: [operación local](#operación-local-no-perder-datos) · [desarrollo](#desarrollo) · [dominio real](#dominio-real-empresa).

### Operación local (no perder datos)

Los datos viven en volúmenes nombrados (`vibecrafthub_pgdata`, `vibecrafthub_bundles`). El compose fija su nombre de proyecto: parar, arrancar o recrear nunca borra datos.

```bash
podman compose up -d          # arrancar
podman compose stop           # parar (conserva todo)
podman compose start          # reanudar
podman compose down           # quita contenedores, LOS DATOS QUEDAN
podman compose up -d --build  # tras cambiar código del repo
podman volume export vibecrafthub_pgdata -o backup.tar   # backup
```

> ⚠️ Nunca `down -v` ni `podman volume prune`: eso sí elimina usuarios, apps y publicaciones.

### Desarrollo

```bash
pnpm install && pnpm build
pnpm test:scanner                 # 12 tests del pipeline
pnpm dev:api                      # API en :3000 (PGlite embebida, sin docker)
pnpm dev:portal                   # portal en :5173 con hot-reload
```

Pruebas de integración contra el API real: `infra/smoke.sh` (15), `infra/smoke-llm.sh` (13), `infra/smoke-account.sh` (16), `infra/smoke-data.sh` (31, data gateway y apps privadas), `infra/smoke-ldap.sh` (13, login corporativo con directorio real desechable; requiere podman), `infra/smoke-metrics.sh` (19, métricas y export de auditoría).

## Data gateway: persistencia por app

Cada app publicada tiene **su propia base de datos SQLite**, compartida entre todos sus usuarios (estado del lado del servidor, sin backend propio). El acceso va por el SDK de la plataforma, en el mismo origen de la app:

```html
<script src="/db/sdk.js"></script>
<script>
  // esquema: responsabilidad de la app
  await VCH.db.run('CREATE TABLE IF NOT EXISTS items (id INTEGER PRIMARY KEY, name TEXT, qty INTEGER)');
  await VCH.db.run('INSERT INTO items (name, qty) VALUES (?, ?)', ['papel A4', 12]);

  const { rows, truncated } = await VCH.db.all('SELECT * FROM items WHERE qty > ?', [0]);
  const item = await VCH.db.get('SELECT * FROM items WHERE name = :n', { n: 'papel A4' });
</script>
```

- **Allowlist de statements**: `SELECT/INSERT/UPDATE/DELETE` y DDL de tablas/índices/vistas. Bloqueados: `ATTACH`, `PRAGMA`, multi-statement.
- **Límites configurables por el admin**: cuota por app (10 MB), timeout (5 s), filas por respuesta (1 000), queries/min por usuario (60).
- **Ciclo de vida**: los datos persisten entre versiones de la app; eliminar la app elimina su BD; el admin puede descargar copia o hacer reset desde el panel.
- Los errores llegan como `Error` con `.code` estable (`VCH_DB_QUOTA_EXCEEDED`, `VCH_DB_RATE_LIMITED`, …).

## Formato del bundle

Zip con un `app.json` obligatorio en la raíz:

```json
{
  "name": "inventario",
  "version": "1.0.0",
  "entrypoint": "index.html",
  "description": "Control de inventario de oficina",
  "database": { "file": "data.sqlite", "seed": true }
}
```

- Extensiones permitidas: `html`, `js`, `css`, `json`, `xml`, `sqlite`. Todo lo demás se rechaza.
- `version` es semver y no puede repetirse por app.
- Límites configurables por el admin: 20 MB y 500 archivos por defecto.

## Pipeline de revisión

| Etapa | Qué revisa | Bloqueo |
|---|---|---|
| **1. Estructura** | zip-slip, manifest válido, extensiones permitidas, firmas binarias MZ/ELF, límites | crítico |
| **2. Reglas estáticas** | `eval`/`new Function` y secrets embebidos (crítica) · `innerHTML`, `document.write`, recursos remotos, WebSockets, `<script>` inline, referencias rotas del HTML a archivos ausentes, uso de `VCH.db` sin cargar su SDK (alta) · `fetch`/XHR externos, service workers (media) · handlers inline, `target=_blank` (baja) | configurable |
| **3. Revisión LLM** | XSS, código ofuscado, exfiltración, lógica maliciosa — con caché por hash de archivo | configurable |

El admin define en el panel qué severidades bloquean y qué hace el pipeline si el LLM no responde (continuar con advertencia o bloquear).

## Configuración

| Variable | Default | Descripción |
|---|---|---|
| `POSTGRES_PASSWORD` | `vch-cambia` | **Cámbiala** antes del primer arranque |
| `PORTAL_HOST` | `portal.vch.local` | Host del portal |
| `APPS_WILDCARD` | `*.apps.vch.local` | Wildcard de las apps |
| `COOKIE_DOMAIN` | `.vch.local` | Domain de la cookie de sesión |
| `COOKIE_SECURE` | `1` | `0` solo para HTTP plano en LAN |
| `APPS_URL_TEMPLATE` | `https://{slug}.apps.vch.local:8443` | Plantilla de URL pública de las apps |

### Dominio real (empresa.com)

- DNS interno con wildcard `*.apps.empresa.com` → la VM.
- En compose: `PORTAL_HOST=portal.empresa.com`, `APPS_WILDCARD=*.apps.empresa.com`, `APPS_HOST_SUFFIX=.apps.empresa.com`, `APPS_ROOT_TEMPLATE=/srv/bundles/{labels.3}/active`, `COOKIE_DOMAIN=.empresa.com`, y el puerto fuera de `APPS_URL_TEMPLATE`.
- Portal y apps deben compartir **dominio base** para que la cookie de sesión funcione.
- Sustituye la CA interna de Caddy por certificados reales si lo prefieres.

### Login corporativo (LDAP / Active Directory)

Configúralo en Admin → Directorio corporativo. Requisitos: servidor con **LDAPS o StartTLS** (cifrado obligatorio).

1. Cuenta de servicio (bind DN + contraseña) o DN directo; filtro de búsqueda configurable (`(mail={login})` en AD, `(uid={login})` en OpenLDAP).
2. Mapeo ordenado de grupos → roles (ej.: `cn=desarrolladores` → developer; resto → user).
3. **Probar conexión** valida bind, búsqueda y autenticación paso a paso antes de activar.

Los empleados entran con sus credenciales del directorio: la cuenta se crea sola al primer ingreso (provisión JIT) y su contraseña se gestiona siempre en el directorio, nunca en la plataforma. El login local queda como rescate para el admin.

### Dominios externos

Por defecto una app no puede contactar nada fuera de sí misma. Si necesita una API interna:

1. El developer declara el dominio en `app.json` (`externalDomains`).
2. El admin lo aprueba en Admin → Dominios externos.
3. La app pasa el pipeline y su CSP abre `connect-src`/`img-src` hacia ese dominio — solo hacia él.

Quitar un dominio aprobado bloquea la próxima publicación de las apps que lo usen (las ya publicadas siguen funcionando hasta entonces).

### Métricas y auditoría

Admin → Métricas de uso: accesos a apps, queries del data gateway, publicaciones y logins (por origen), agregados por día con rangos de 24 horas, 7 y 30 días. Todo exportable a CSV.

Admin → Export de auditoría: el historial completo de publicaciones (con hallazgos por intento) y las acciones de administración, en CSV o JSON, filtrable por rango de fechas y app. Ambos requieren rol admin.

### LLM local

Apunta la URL base a tu servidor OpenAI-compatible. Desde contenedor: `http://host.containers.internal:11434/v1` (Ollama), llama.cpp o vLLM. El código nunca sale de la empresa.

## Roadmap

| Versión | Alcance | Estado |
|---|---|---|
| **v0.1** | Catálogo, publicación con pipeline, revisión LLM, auditoría, administración | ✅ |
| **v0.2** | Data gateway: SQLite compartida por app vía SDK, apps privadas con allowlist | ✅ esta release |
| **v0.3** | Conector LDAP/Active Directory, allowlist de dominios externos | ✅ esta release |
| **v1.0** | Métricas de uso, export de auditoría, endurecimiento multi-replica | ✅ métricas y auditoría (multi-replica aplazada) |

## Licencia

[MIT](LICENSE)
