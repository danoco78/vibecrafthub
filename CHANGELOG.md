# Changelog

Formato basado en [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/) y [SemVer](https://semver.org/lang/es/).

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

[0.1.0]: https://github.com/danoco78/vibecrafthub/releases/tag/v0.1.0
