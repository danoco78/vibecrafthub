import type { Finding } from '../api';

const LABELS: Record<string, string> = {
  critical: 'Crítica',
  high: 'Alta',
  medium: 'Media',
  low: 'Baja',
  info: 'Info',
};

export function SeverityBadge({ severity }: { severity: string }) {
  return <span className={`badge ${severity}`}>{LABELS[severity] ?? severity}</span>;
}

export function FindingsTable({ findings }: { findings: Finding[] }) {
  if (findings.length === 0) {
    return <p className="muted">Sin hallazgos: el bundle cumplió todas las revisiones.</p>;
  }
  const order = { critical: 0, high: 1, medium: 2, low: 3, info: 4 } as const;
  const sorted = [...findings].sort((a, b) => order[a.severity] - order[b.severity]);
  return (
    <div>
      {sorted.map((f, i) => (
        <div className="finding" key={i}>
          <div className="head">
            <SeverityBadge severity={f.severity} />
            <span className="loc">
              {f.file}
              {f.line > 0 ? `:${f.line}` : ''} · {f.rule}
            </span>
          </div>
          <div className="msg">{f.message}</div>
          <div className="fix">{f.fix}</div>
          {f.snippet && <pre>{f.snippet}</pre>}
        </div>
      ))}
    </div>
  );
}
