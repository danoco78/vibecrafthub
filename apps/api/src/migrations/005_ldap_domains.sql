-- v0.3: conector LDAP/AD y allowlist de dominios externos

-- Identidad híbrida: origen de autenticación y DN del directorio
ALTER TABLE users ADD COLUMN IF NOT EXISTS auth_source TEXT NOT NULL DEFAULT 'local'
  CHECK (auth_source IN ('local', 'ldap'));
ALTER TABLE users ADD COLUMN IF NOT EXISTS ldap_dn TEXT;

-- Configuración del directorio (fila única, patrón llm_config)
CREATE TABLE IF NOT EXISTS ldap_config (
  id             INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  enabled        BOOLEAN NOT NULL DEFAULT false,
  mode           TEXT NOT NULL DEFAULT 'ldaps' CHECK (mode IN ('ldaps', 'starttls')),
  url            TEXT NOT NULL DEFAULT '',
  base_dn        TEXT NOT NULL DEFAULT '',
  bind_mode      TEXT NOT NULL DEFAULT 'service' CHECK (bind_mode IN ('service', 'direct')),
  bind_dn        TEXT NOT NULL DEFAULT '',
  bind_password  TEXT NOT NULL DEFAULT '',
  user_dn_pattern TEXT NOT NULL DEFAULT '',
  user_filter    TEXT NOT NULL DEFAULT '',
  mail_attr      TEXT NOT NULL DEFAULT 'mail',
  group_attr     TEXT NOT NULL DEFAULT 'memberOf',
  tls_skip_verify BOOLEAN NOT NULL DEFAULT false,
  role_mappings  JSONB NOT NULL DEFAULT '[]'::jsonb,
  default_role   TEXT NOT NULL DEFAULT 'user' CHECK (default_role IN ('admin', 'developer', 'user')),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO ldap_config (id) VALUES (1) ON CONFLICT DO NOTHING;

-- Allowlist de dominios externos aprobados por el admin (exactos, sin esquema/puerto)
CREATE TABLE IF NOT EXISTS external_domain_allowlist (
  domain     TEXT PRIMARY KEY,
  note       TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Dominios externos declarados (normalizados) por cada versión publicada:
-- alimentan la CSP por app (intersección dinámica con la allowlist)
ALTER TABLE app_versions ADD COLUMN IF NOT EXISTS external_domains JSONB NOT NULL DEFAULT '[]'::jsonb;
