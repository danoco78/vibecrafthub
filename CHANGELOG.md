# Changelog

Formato basado en [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/) y [SemVer](https://semver.org/lang/es/).

## [1.0.0] - 2026-10-25

Métricas de uso y export de auditoría: observabilidad completa de la plataforma. Diseño de referencia: `docs/design-v1.0-metrics-audit.md`. (El endurecimiento multi-replica se discutirá como hito aparte.)

### Added

- **Métricas de uso**: contadores agregados por día de logins (origen y resultado), publicaciones por app (ok/rechazo), queries del data gateway (ok/error) y accesos a apps. Buffer en memoria con flush batch cada 10 s y al apagar (SIGTERM/SIGINT).
- **Panel de métricas**: rangos de 24 horas, 7 y 30 días; tarjetas de resumen con barras segmentadas y tabla por app — sin librerías de gráficos.
- **Export CSV de métricas** (`day,metric,key,value`) por rango.
- **Export de auditoría**: publicaciones (una fila por intento, hallazgos como JSON compacto; JSON con hallazgos expandidos) y acciones de administración, filtrables por rango de fechas y app.
- **Auditoría ampliada**: la alta de usuarios por admin queda registrada en `admin_actions`.
- **`infra/smoke-metrics.sh`**: 19 pruebas end-to-end (conteos tras flush, permisos, exports con filtros y formatos).

### Security

- Métricas y exports: solo rol admin (403 para el resto, verificado).
- El export de auditoría es de solo lectura: el historial inmutable no se altera.

[1.0.0]: https://github.com/danoco78/vibecrafthub/releases/tag/v1.0.0

## [0.3.0] - 2026-10-23

Login corporativo con LDAP/Active Directory y allowlist de dominios externos. Diseño de referencia: `docs/design-v0.3.md`.

### Added

- **Login corporativo LDAP/AD**: coexiste con el login local (que queda como rescate). Provisión JIT: la cuenta se crea sola al primer ingreso con el rol salido del mapeo de grupos. Modo de bind por cuenta de servicio o DN directo; filtros y atributos configurables (AD y OpenLDAP); rate limiting y sesiones idénticos al flujo local.
- **Roles por grupos**: mapeo ordenado grupos→roles configurable por el admin (coincidencia por DN o CN, insensible a mayúsculas); el directorio manda el rol en cada entrada.
- **Identidad híbrida**: `auth_source` por usuario — las cuentas del directorio no gestionan contraseña en la plataforma (ni cambio propio ni reset de admin) y se muestran con badge LDAP.
- **Test de conexión**: el admin valida bind, búsqueda y autenticación paso a paso desde el panel, sin esperar un intento real de empleado.
- **Allowlist de dominios externos**: el admin aprueba dominios exactos; las apps que los declaran en `app.json` pasan el pipeline sin hallazgos y obtienen CSP que les permite consumirlos (`connect-src`/`img-src`).
- **CSP por app**: generada dinámicamente aprovechando el `forward_auth` existente (sin peticiones extra); quitar un dominio de la allowlist aplica al vuelo.
- **Panel ampliado**: secciones Directorio (config + probar conexión) y Dominios externos (CRUD); badges de dominios en el detalle de cada app; badge LDAP en el listado de usuarios.
- **`infra/smoke-ldap.sh`**: 13 pruebas contra un directorio real desechable en podman (glauth con LDAPS): test de conexión, JIT, roles, guards y 503 con directorio caído.

### Security

- Las contraseñas del directorio **jamás se almacenan** en la plataforma: cada login hace bind con las credenciales del empleado.
- TLS obligatorio hacia el directorio (LDAPS o StartTLS); `tls_skip_verify` existe solo para laboratorios y queda registrado en la configuración.
- Escape anti LDAP-injection en filtros y DNs; credenciales de la cuenta de servicio nunca expuestas (enmascaradas en el panel).
- Quitar un dominio aprobado bloquea la próxima publicación de las apps que dependan de él (la CSP viva se recalcula al momento).
- Usuarios del directorio: sin cambio propio ni restablecimiento de contraseña local; la desactivación manual de la plataforma sigue operando.

## [0.2.0] - 2026-10-17

Data gateway (BD SQLite por app) y apps privadas con allowlist. Diseño de referencia: `docs/design-v0.2.md`.

### Added

- **Data gateway — una SQLite por app**: las apps publicadas tienen persistencia real del lado del servidor, compartida entre todos sus usuarios y aislada por completo de otras apps. Archivo por app en volumen propio (`appdb`), modo WAL, creación lazy.
- **SDK JS servido por la plataforma** (`/db/sdk.js` en el subdominio de la app, mismo origen): `VCH.db.all/get/run` con SQL parametrizado (posicionales y nombrados). No se empaqueta en el zip.
- **Excepción CSP quirúrgica**: el gateway se publica en `{slug}.apps.*/db/` proxificado por Caddy al API; el slug se resuelve por el `Host` header, nunca por input del cliente. `/api/*` sigue inalcanzable desde el dominio de apps.
- **Motor SQL con allowlist**: `SELECT/INSERT/UPDATE/DELETE` + DDL acotado (`CREATE/ALTER/DROP TABLE·INDEX·VIEW`); bloqueados `ATTACH`, `PRAGMA`, multi-statement y modo inconsistente con el statement. Lecturas truncadas en `maxRows` sin materializar resultados enormes; escrituras con savepoint y rollback automático al exceder la cuota.
- **Límites configurables por el admin**: cuota por app (10 MB), timeout busy-wait (5 s), filas por respuesta (1 000) y queries/min por usuario (60), desde el panel.
- **Rate limit de `/db/query`** por app+usuario con error tipado `VCH_DB_RATE_LIMITED`.
- **Errores tipados estables** (`VCH_DB_*`) expuestos por el SDK.
- **Apps privadas con allowlist**: visibilidad `pública`/`privada` por app (nacen públicas); allowlist de usuarios individuales gestionada por owner/admin desde el portal.
- **Asistente «¿Cómo crear mis apps?»**: formulario corto en Mis apps que genera un prompt listo para pegar en cualquier IA, con todas las restricciones de la plataforma ya incorporadas (formato del bundle, reglas del pipeline, SDK del data gateway). El empleado no necesita saber nada técnico.
- **Reglas nuevas del scanner**: `missing-referenced-file` — el HTML referencia archivos que no vienen en el zip (el error clásico de apps generadas con IA) —, `inline-script` — bloques `<script>` que la CSP bloquea y dejan la app muerta — y `vch-sdk-not-loaded` — la app usa `VCH.db` pero ningún HTML carga `/db/sdk.js` (persistencia rota o silenciosa, detectada en el caso real To-Do 1.1.0). Todas en alta, con reporte de archivo/línea y corrección.
- **Historial solo para admin y developer**: la pestaña desaparece para rol `user`, la página redirige y la API responde 403 (`/api/attempts`, `/api/attempts/:id`). Cubierto por 3 pruebas nuevas en `smoke.sh`.
- **Vista previa en modo dev funcional**: la plantilla de apps en desarrollo pasa a ruta relativa (`/bundles/{slug}/`) para que el iframe herede la sesión vía proxy de vite; el portal ahora sugiere aceptar el certificado del subdominio cuando el iframe se ve en blanco (limitación de TLS en iframes).
- **Enforcement en dos capas**: el catálogo solo lista lo visible para cada usuario; el `forward_auth` de Caddy rechaza el subdominio de apps privadas con página 403 amigable (assets y `/db/` por igual).
- **Administración de BDs**: vista de uso por app, descarga de copia consistente (checkpoint al cerrar) y reset con confirmación; ambas acciones en el nuevo log `admin_actions`.
- **Ciclo de vida**: la BD persiste entre versiones de la app; eliminar la app elimina su BD y su allowlist; desactivar versiones no toca los datos.
- **31 pruebas de integración nuevas** (`infra/smoke-data.sh`): CRUD SQL, allowlist de statements, truncado de filas, cuota con rollback, allowlist de apps privadas (catálogo, forward_auth con Host, BD), admin (uso/descarga/reset) y rate limit.

### Security

- Resolución de app únicamente por `Host` (producción) o path (dev): una app jamás alcanza la BD de otra.
- Statements fuera del allowlist, `ATTACH` y `PRAGMA` de escritura rechazados antes de ejecutar.
- Cuota de disco con verificación `page_count × page_size` y rollback del statement que la excede.
- Parámetros de hasta 4 MB validados por tipo; SQL limitado a 100 KB; un statement por request.
- Descarga y reset de BDs requieren admin y quedan auditados.

## [0.1.0] - 2026-10-16

Primera versión funcional del producto: publicación autónoma de apps web internas con pipeline de seguridad, catálogo y auditoría completa.

### Added

- **Publicación autónoma de apps**: el empleado sube un zip (html, js, css, json, xml, sqlite opcional) con manifiesto `app.json`; sin intervención de TI.
- **Pipeline de revisión en 3 etapas**:
  - Estructura: zip-slip, manifiesto, extensiones permitidas, firmas binarias MZ/ELF disfrazadas, límites de tamaño y cantidad, encabezado e `integrity_check` de SQLite.
  - Reglas estáticas con severidades: `eval`/`new Function`, secrets embebidos, `innerHTML`/`document.write`, recursos remotos, WebSockets, service workers, handlers inline.
  - Revisión semántica con LLM (OpenAI-compatible o Anthropic, cloud o local) con caché por hash de archivo y política configurable ante indisponibilidad.
- **Política configurable**: el admin define qué severidades bloquean una publicación y los límites del bundle (MB, archivos).
- **Reporte de rechazo detallado**: regla, archivo, línea, fragmento y corrección sugerida por hallazgo.
- **Historial de auditoría inmutable**: todo intento de publicación con sus hallazgos, veredicto, hash del bundle y metadatos de la revisión LLM.
- **Catálogo y aislamiento**: apps servidas en subdominios dedicados (`<slug>.apps.*`) con TLS, CSP `default-src 'self'`, `forward_auth` (sesión obligatoria) e iframe sandbox.
- **Autenticación y usuarios**: registro local (Argon2id), sesiones httpOnly, roles admin/developer/user, primer registro = admin.
- **Panel de administración**: alta de usuarios, activación/desactivación con invalidación de sesiones, restablecimiento de contraseñas, política de publicación, configuración de la revisión LLM (proveedor, URL base, modelo, API key enmascarada, política de indisponibilidad).
- **Gestión de apps**: activación de versiones (rollback incluido), eliminación con limpieza de volúmenes, historial por app.
- **Cuenta**: cambio de contraseña autogestionado con validación de fortaleza.
- **Rate limiting de login**: 5 fallos por email+IP en 15 minutos.
- **Página 401 amigable** en subdominios de apps con enlace al portal.
- **Despliegue**: `podman compose up -d --build` (gateway Caddy + API Fastify + PostgreSQL), nombre de proyecto fijado para preservar volúmenes, TLS con CA interna.
- **Dev-ex**: monorepo pnpm, PGlite embebida para desarrollo sin docker, 56 pruebas de integración (smoke general, LLM y cuentas) + 12 tests unitarios del scanner.

### Security

- Validación de rutas anti zip-slip y escritura confinada al volumen del bundle.
- Rechazo de ejecutables disfrazados (magic bytes) y de archivos SQLite corruptos.
- Detección de secretos embebidos (AWS, OpenAI, GitHub, claves privadas) como hallazgo crítico.
- Ninguna app publicada puede invocar la API de la plataforma (cross-origin + CSP).
- API keys del proveedor LLM nunca expuestas en el portal (solo máscara).

[1.0.0]: https://github.com/danoco78/vibecrafthub/releases/tag/v1.0.0
[0.3.0]: https://github.com/danoco78/vibecrafthub/releases/tag/v0.3.0
[0.2.0]: https://github.com/danoco78/vibecrafthub/releases/tag/v0.2.0
[0.1.0]: https://github.com/danoco78/vibecrafthub/releases/tag/v0.1.0
