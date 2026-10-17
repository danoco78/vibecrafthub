import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_POLICY, type Policy } from '@vch/shared';
import { scanBundle, verdictFromFindings } from './scan.js';
import type { BundleEntry } from './types.js';

const POLICY: Policy = DEFAULT_POLICY;

function entry(path: string, content: string | Buffer): BundleEntry {
  return { path, data: Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8'), isDir: false };
}

const VALID_MANIFEST = JSON.stringify({
  name: 'demo',
  version: '1.0.0',
  entrypoint: 'index.html',
});

test('bundle válido publica sin hallazgos', () => {
  const { findings, manifest } = scanBundle(
    [
      entry('app.json', VALID_MANIFEST),
      entry('index.html', '<!doctype html><html><body><h1>Hola</h1></body></html>'),
      entry('styles.css', 'body { color: #222; }'),
    ],
    POLICY,
  );
  assert.equal(manifest?.name, 'demo');
  assert.deepEqual(findings, []);
  assert.equal(verdictFromFindings(findings, POLICY), 'published');
});

test('eval() genera hallazgo crítico que rechaza', () => {
  const { findings } = scanBundle(
    [
      entry('app.json', VALID_MANIFEST),
      entry('index.html', '<!doctype html><html><body></body></html>'),
      entry('app.js', "const x = eval(userInput);\nconsole.log(x);"),
    ],
    POLICY,
  );
  const f = findings.find((f) => f.rule === 'no-eval');
  assert.ok(f, 'debe existir finding no-eval');
  assert.equal(f.severity, 'critical');
  assert.equal(f.line, 1);
  assert.equal(verdictFromFindings(findings, POLICY), 'rejected');
});

test('detecta secret embebido', () => {
  const { findings } = scanBundle(
    [
      entry('app.json', VALID_MANIFEST),
      entry('index.html', '<!doctype html><html><body></body></html>'),
      entry('config.js', "const key = 'sk-abcdefghij0123456789abcdefghij';"),
    ],
    POLICY,
  );
  assert.ok(findings.some((f) => f.rule === 'secret-openai-key'));
});

test('rechaza entrada con zip-slip', () => {
  const { findings } = scanBundle(
    [
      entry('app.json', VALID_MANIFEST),
      entry('index.html', '<html></html>'),
      entry('../evil.js', 'malicious'),
    ],
    POLICY,
  );
  assert.ok(findings.some((f) => f.rule === 'zip-slip' && f.severity === 'critical'));
});

test('rechaza extensión no permitida', () => {
  const { findings } = scanBundle(
    [
      entry('app.json', VALID_MANIFEST),
      entry('index.html', '<html></html>'),
      entry('virus.exe', Buffer.from('MZ1234')),
    ],
    POLICY,
  );
  assert.ok(findings.some((f) => f.rule === 'structure-extension'));
});

test('rechaza binario disfrazado con extensión js', () => {
  const { findings } = scanBundle(
    [
      entry('app.json', VALID_MANIFEST),
      entry('index.html', '<html></html>'),
      entry('payload.js', Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02])),
    ],
    POLICY,
  );
  assert.ok(findings.some((f) => f.rule === 'binary-disguised'));
});

test('rechaza sqlite con encabezado inválido', () => {
  const { findings } = scanBundle(
    [
      entry('app.json', JSON.stringify({ name: 'd', version: '1.0.0', entrypoint: 'index.html' })),
      entry('index.html', '<html></html>'),
      entry('data.sqlite', Buffer.from('esto no es sqlite')),
    ],
    POLICY,
  );
  assert.ok(findings.some((f) => f.rule === 'sqlite-header'));
});

test('rechaza bundle sin manifest', () => {
  const { findings } = scanBundle([entry('index.html', '<html></html>')], POLICY);
  assert.ok(findings.some((f) => f.rule === 'manifest-missing'));
  assert.equal(verdictFromFindings(findings, POLICY), 'rejected');
});

test('rechaza entrypoint inexistente', () => {
  const { findings } = scanBundle(
    [
      entry('app.json', JSON.stringify({ name: 'd', version: '1.0.0', entrypoint: 'home.html' })),
      entry('index.html', '<html></html>'),
    ],
    POLICY,
  );
  assert.ok(findings.some((f) => f.rule === 'manifest-entrypoint-missing'));
});

test('dominios externos sin allowlist generan hallazgo alto', () => {
  const { findings } = scanBundle(
    [
      entry(
        'app.json',
        JSON.stringify({
          name: 'd',
          version: '1.0.0',
          entrypoint: 'index.html',
          externalDomains: ['api.ejemplo.com'],
        }),
      ),
      entry('index.html', '<html></html>'),
    ],
    POLICY,
  );
  assert.ok(findings.some((f) => f.rule === 'manifest-external-domains' && f.severity === 'high'));
});

test('límite de archivos aplica', () => {
  const entries: BundleEntry[] = [
    entry('app.json', VALID_MANIFEST),
    entry('index.html', '<html></html>'),
  ];
  for (let i = 0; i < 12; i++) entries.push(entry(`f${i}.js`, 'x'));
  const { findings } = scanBundle(entries, { ...POLICY, maxFiles: 10 });
  assert.ok(findings.some((f) => f.rule === 'limit-files'));
});

test('innerHTML y fetch externo se reportan', () => {
  const { findings } = scanBundle(
    [
      entry('app.json', VALID_MANIFEST),
      entry('index.html', '<html><body><img src="https://rastreador.ejemplo.com/pixel.png"></body></html>'),
      entry('app.js', "el.innerHTML = dato;\nfetch('https://api.ejemplo.com/v1');"),
    ],
    POLICY,
  );
  assert.ok(findings.some((f) => f.rule === 'no-innerhtml-assign'));
  assert.ok(findings.some((f) => f.rule === 'remote-fetch'));
  assert.ok(findings.some((f) => f.rule === 'remote-image'));
});
