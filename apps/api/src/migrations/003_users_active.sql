-- Desactivación de usuarios (soft disable): conservan historial y referencias FK

ALTER TABLE users ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT true;
