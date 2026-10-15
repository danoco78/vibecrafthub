-- Esquema inicial de la plataforma

CREATE TABLE users (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('admin', 'developer', 'user')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_sessions_token ON sessions(token_hash);

CREATE TABLE apps (
  id                 BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  slug               TEXT NOT NULL UNIQUE,
  name               TEXT NOT NULL,
  description        TEXT NOT NULL DEFAULT '',
  owner_id           BIGINT NOT NULL REFERENCES users(id),
  visibility         TEXT NOT NULL DEFAULT 'public' CHECK (visibility IN ('public', 'private')),
  current_version_id BIGINT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE app_versions (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  app_id      BIGINT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  version     TEXT NOT NULL,
  bundle_hash TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'published' CHECK (status IN ('published', 'active')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (app_id, version)
);

ALTER TABLE apps ADD CONSTRAINT fk_apps_current_version
  FOREIGN KEY (current_version_id) REFERENCES app_versions(id);

-- Cada intento de publicación (exitoso o rechazado) queda registrado e inmutable.
CREATE TABLE publish_attempts (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  app_id      BIGINT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  user_id     BIGINT NOT NULL REFERENCES users(id),
  version_id  BIGINT REFERENCES app_versions(id),
  verdict     TEXT NOT NULL CHECK (verdict IN ('published', 'rejected')),
  findings    JSONB NOT NULL DEFAULT '[]'::jsonb,
  bundle_hash TEXT NOT NULL DEFAULT '',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_attempts_app ON publish_attempts(app_id, created_at DESC);

-- Allowlist de apps privadas (se usa desde v1; el campo visibility ya existe en MVP)
CREATE TABLE app_members (
  app_id  BIGINT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (app_id, user_id)
);

-- Política de publicación (fila única id = 1)
CREATE TABLE policy (
  id               INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  block_severities TEXT[] NOT NULL DEFAULT '{critical,high}',
  max_bundle_mb    INT NOT NULL DEFAULT 20,
  max_files        INT NOT NULL DEFAULT 500
);
INSERT INTO policy (id) VALUES (1) ON CONFLICT DO NOTHING;
