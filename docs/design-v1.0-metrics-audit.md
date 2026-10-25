# Diseño v1.0 — Métricas de uso y Export de auditoría

Estado: **contrato del hito** (implementación pendiente)
Fecha: 2026-10-23
Rama: `v1.0-metrics-audit-hardening`
Alcance: dos features. El endurecimiento multi-replica **queda aplazado** a una
conversación aparte (no forma parte de este hito).

---

## 1. Objetivos

1. **Métricas de uso**: contadores agregados por día de la actividad real de la
   plataforma (logins por origen, publicaciones, queries del data gateway y
   accesos a apps), visibles en el panel con rangos 24 h / 7 días / 30 días y
   exportables a CSV.
2. **Export de auditoría**: descarga del historial de publicaciones y de las
   acciones de administración, filtrable por rango de fechas y app, en CSV o JSON.

## 2. Fuera de alcance (no-goals para v1.0)

- Endurecimiento multi-replica (rate limits compartidos, estado entre réplicas):
  **aplazado**, se discutirá como hito aparte.
- Tiempo real / websockets / gráficos animados (el panel usa tablas y barras CSS).
- Métricas por usuario individual (cardinalidad innecesaria; solo por app y por
  tipo de evento).
- Purga automática de métricas (los volúmenes son diminutos; revisar en v1.x).

## 3. Decisiones registradas

| # | Decisión | Resolución |
|---|---|---|
| 1 | Alcance del hito | Métricas de uso + export de auditoría; multi-replica aplazada |
| 2 | Efecto de la allowlist en métricas | N/A — las métricas no cambian el comportamiento, solo observan |
| 3 | Fuentes instrumentadas | Logins (origen + resultado), publicaciones (veredicto), queries del data gateway (por app), accesos a apps (por app) |
| 4 | Almacenamiento | Tabla `metric_daily` (día, métrica, clave, valor) con upsert incremental |
| 5 | Escritura | **Buffer en memoria con flush cada 10 s** (y al apagar): un solo upsert batch por flush; ventana de pérdida ≤10 s ante crash, aceptable para métricas de uso |
| 6 | Panel | Rango 24 h / 7 días / 30 días: resumen global + tabla por app con barras CSS (sin librerías de gráficos) |
| 7 | Export de métricas | CSV `(día, métrica, clave, valor)` del rango elegido |
| 8 | Export de auditoría | **CSV** (una fila por intento; hallazgos como JSON compacto) y **JSON** (hallazgos expandidos); filtros: rango de fechas y app; incluye también `admin_actions` |
| 9 | Acceso | Ambos exports y métricas: solo **admin** |
| 10 | Cardinalidad | Los accesos y queries se cuentan por app (slug), no por usuario |

---

## 4. Feature 1: Métricas de uso

### 4.1 Modelo

```sql
CREATE TABLE metric_daily (
  day   DATE NOT NULL,
  metric TEXT NOT NULL,
  key   TEXT NOT NULL DEFAULT '',
  value BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (day, metric, key)
);
```

Métricas registradas:

| Métrica | Clave | Punto de instrumentación |
|---|---|---|
| `login.ok` | `local` / `ldap` | handlers de login |
| `login.fail` | `local` / `ldap` | fallos de credenciales (no cuenta 503 de directorio caído ni 429) |
| `publish.ok` / `publish.rejected` | slug | `persistAttempt` |
| `dbquery.ok` / `dbquery.error` | slug | data gateway tras ejecutar |
| `appaccess` | slug | `/api/auth/check` (producción: Caddy lo llama por cada asset) y ruta dev de bundles |

### 4.2 Escritura (buffer con flush)

- `src/metrics/collector.ts`: `count(metric, key, n=1)` acumula en un `Map`;
  `setInterval` de 10 s ejecuta un **upsert batch** (una query multi-valores por
  métrica) y limpia el buffer; `flushMetrics()` exportado para flush al apagar
  (`SIGTERM`/`SIGINT`) y tras los tests.
- Los conteos sobreviven a reinicios limpios; ante crash se pierden ≤10 s de
  agregados (documentado).

### 4.3 Lectura

- `GET /api/admin/metrics?days=1|7|30` →
  `{ days, summary: { loginOkLocal, loginOkLdap, loginFail, publishOk, publishRejected, dbQueries, appAccess },
     apps: [{ slug, access, dbQueries, publishOk, publishRejected }] }` (agregado SQL por métrica del rango).
- `GET /api/admin/metrics/export?days=30` → CSV `day,metric,key,value`.

### 4.4 Panel

Admin → **Métricas de uso**: selector de rango (3 botones), tarjetas de resumen
con barra CSS proporcional, y tabla "Por app" (accesos, queries, publicaciones)
ordenada por accesos. Sin librerías de gráficos: barras con `div` proporcionales.

---

## 5. Feature 2: Export de auditoría

### 5.1 Superficie

`GET /api/admin/audit/export?type=publishes|actions&from=YYYY-MM-DD&to=YYYY-MM-DD&slug=<opcional>&format=csv|json`

- `type=publishes` (default): `publish_attempts` con join a apps y usuarios.
- `type=actions`: `admin_actions` con email del admin.
- `from`/`to` inclusivos sobre `created_at::date`; `slug` filtra por app (solo publishes).
- Respuesta: `text/csv` con `Content-Disposition: attachment` o `application/json`.

### 5.2 Formato CSV (publishes)

Una fila por intento:
`id, fecha, app_slug, app_name, usuario, veredicto, version, bundle_hash, total_hallazgos, hallazgos (JSON compacto)`
Los hallazgos van como JSON en una sola columna (quoted); el JSON expandido
(una fila por hallazgo) pertenece al formato `json`.

### 5.3 Panel

Admin → **Export de auditoría**: tarjeta con rango de fechas (default: mes en
curso), selector de tipo (publicaciones / acciones de admin), formato (CSV/JSON)
y botón Descargar (fetch + blob, con la sesión del admin).

---

## 6. Cambios transversales previstos

| Área | Cambio |
|---|---|
| Esquema PG (migración 006) | `metric_daily` |
| API | `src/metrics/collector.ts` + instrumentación en login, publish, data gateway y auth/check; endpoints de métricas y export de auditoría (`src/metrics/routes.ts`, `src/admin/audit.ts`) |
| Portal | `MetricsSection` (admin) + tarjeta Export de auditoría en AdminPage |
| Scanner | Sin cambios |
| Tests | `smoke-metrics.sh`: conteos por login/publish/query/acceso, export CSV de métricas y de auditoría, filtros por rango |
| Docs | README bilingüe (sección métricas + export), CHANGELOG 1.0.0, badges |

---

## 7. Plan de implementación propuesto (orden, sin código)

1. **Fundaciones**: migración 006, collector con buffer/flush, instrumentación de login y publicaciones.
2. **Data gateway + accesos**: conteos de queries y de `auth/check`; endpoints de lectura y export CSV de métricas.
3. **Panel de métricas**: `MetricsSection` con rangos y barras CSS.
4. **Export de auditoría**: endpoints (publishes/actions, csv/json) + tarjeta en el panel.
5. **Calidad y docs**: `smoke-metrics.sh`, README bilingüe, CHANGELOG 1.0.0, versiones.

## 8. Preguntas abiertas (se resuelven durante la implementación)

- Umbral del flush (10 s) tras observar carga real.
- ¿Gráfico de línea temporal (por día) además de tablas? Depende de cuán legible quede con CSS puro.
