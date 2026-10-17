-- Configuración de revisión de código con LLM + caché por archivo + metadatos de intentos

CREATE TABLE IF NOT EXISTS llm_config (
  id             INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  enabled        BOOLEAN NOT NULL DEFAULT false,
  provider       TEXT NOT NULL DEFAULT 'openai' CHECK (provider IN ('openai', 'anthropic')),
  base_url       TEXT NOT NULL DEFAULT '',
  model          TEXT NOT NULL DEFAULT '',
  api_key        TEXT NOT NULL DEFAULT '',
  on_unavailable TEXT NOT NULL DEFAULT 'continue' CHECK (on_unavailable IN ('continue', 'block')),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO llm_config (id) VALUES (1) ON CONFLICT DO NOTHING;

-- Metadatos del intento: info de la revisión LLM (proveedor, modelo, caché)
ALTER TABLE publish_attempts ADD COLUMN IF NOT EXISTS meta JSONB NOT NULL DEFAULT '{}'::jsonb;

-- Caché de revisión LLM por hash de contenido+modelo: archivo sin cambios no se re-analiza
CREATE TABLE IF NOT EXISTS llm_file_cache (
  file_hash  TEXT PRIMARY KEY,
  model      TEXT NOT NULL,
  findings   JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
