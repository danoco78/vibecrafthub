-- v1.0: métricas de uso — contadores agregados por día (docs/design-v1.0-metrics-audit.md §4.1)

CREATE TABLE IF NOT EXISTS metric_daily (
  day   DATE NOT NULL,
  metric TEXT NOT NULL,
  key   TEXT NOT NULL DEFAULT '',
  value BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (day, metric, key)
);
