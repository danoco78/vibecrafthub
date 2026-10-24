-- Data gateway (v0.2): BD SQLite por app + límites configurables + auditoría de acciones admin.
-- La allowlist de apps privadas ya existe: tabla app_members (ver 001_init.sql).

-- Metadatos de la BD de cada app (se actualiza en cada escritura exitosa)
CREATE TABLE IF NOT EXISTS app_databases (
  app_id     BIGINT PRIMARY KEY REFERENCES apps(id) ON DELETE CASCADE,
  size_bytes BIGINT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Allowlist de apps privadas: registrar cuándo se añadió cada miembro
ALTER TABLE app_members ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now();

-- Límites del gateway (fila única id = 1), estilo policy/llm_config
CREATE TABLE IF NOT EXISTS db_config (
  id                INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  quota_mb          INT NOT NULL DEFAULT 10,
  timeout_ms        INT NOT NULL DEFAULT 5000,
  max_rows          INT NOT NULL DEFAULT 1000,
  rate_limit_per_min INT NOT NULL DEFAULT 60,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO db_config (id) VALUES (1) ON CONFLICT DO NOTHING;

-- Auditoría de acciones administrativas (descargar/reset BD, …)
CREATE TABLE IF NOT EXISTS admin_actions (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id    BIGINT NOT NULL REFERENCES users(id),
  action     TEXT NOT NULL,
  target     TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_admin_actions_created ON admin_actions(created_at DESC);
