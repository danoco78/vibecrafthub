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

test('rechaza referencias a archivos que no vienen en el bundle (caso real: app generada con IA)', () => {
  // El HTML referencia js/app.js y css/style.css pero el zip solo trajo index.html
  const { findings } = scanBundle(
    [
      entry('app.json', VALID_MANIFEST),
      entry(
        'index.html',
        [
          '<!doctype html><html><head>',
          '<link rel="stylesheet" href="css/style.css">',
          '<script src="/db/sdk.js"></script>',
          '<script src="js/app.js"></script>',
          '</head><body></body></html>',
        ].join('\n'),
      ),
    ],
    POLICY,
  );
  const missing = findings.filter((f) => f.rule === 'missing-referenced-file');
  assert.equal(missing.length, 2, `esperaba 2 referencias rotas, hubo: ${findings.map((f) => f.rule).join(', ')}`);
  assert.ok(missing.every((f) => f.severity === 'high'));
  assert.ok(missing.some((f) => f.file === 'index.html' && f.line === 2 && f.message.includes('css/style.css')));
  assert.ok(missing.some((f) => f.file === 'index.html' && f.line === 4 && f.message.includes('js/app.js')));
  assert.equal(verdictFromFindings(findings, POLICY), 'rejected');
  // el SDK de la plataforma (/db/sdk.js) NO es una referencia rota
  assert.ok(!missing.some((f) => f.message.includes('/db/sdk.js')));
});

test('referencias existentes con rutas relativas no generan hallazgos', () => {
  const { findings } = scanBundle(
    [
      entry('app.json', VALID_MANIFEST),
      entry('index.html', '<html><head><link rel="stylesheet" href="./css/style.css"></head><body><a href="ayuda.html">?</a></body></html>'),
      entry('css/style.css', 'body{}'),
      entry('ayuda.html', '<html></html>'),
      entry('pages/detalle.html', '<html><head><script src="../js/util.js"></script></head></html>'),
      entry('js/util.js', 'x'),
    ],
    POLICY,
  );
  assert.ok(!findings.some((f) => f.rule === 'missing-referenced-file'), JSON.stringify(findings));
});

test('favicon inexistente no se reporta (extensión no permitida)', () => {
  const { findings } = scanBundle(
    [
      entry('app.json', VALID_MANIFEST),
      entry('index.html', '<html><head><link rel="icon" href="favicon.ico"></head><body></body></html>'),
    ],
    POLICY,
  );
  assert.ok(!findings.some((f) => f.rule === 'missing-referenced-file'));
});

test('script inline genera hallazgo alto (la CSP lo bloquea)', () => {
  const { findings } = scanBundle(
    [
      entry('app.json', VALID_MANIFEST),
      entry(
        'index.html',
        ['<html><body>', '<script>console.log("muerto por CSP");</script>', '<script src="app.js"></script>', '</body></html>'].join('\n'),
      ),
      entry('app.js', 'console.log("vivo");'),
    ],
    POLICY,
  );
  const inline = findings.filter((f) => f.rule === 'inline-script');
  assert.equal(inline.length, 1);
  assert.equal(inline[0].severity, 'high');
  assert.equal(inline[0].line, 2);
  assert.equal(verdictFromFindings(findings, POLICY), 'rejected');
});

test('usa VCH.db sin cargar /db/sdk.js → hallazgo alto (caso To-Do 1.1.0)', () => {
  // Patrón real: app.js con degradación silenciosa, index.html sin el SDK
  const { findings } = scanBundle(
    [
      entry('app.json', VALID_MANIFEST),
      entry('index.html', '<html><head><script src="js/app.js" defer></script></head><body></body></html>'),
      entry(
        'js/app.js',
        [
          'function db() {',
          "  return (typeof VCH !== 'undefined' && VCH && VCH.db) ? VCH.db : null;",
          '}',
          'await VCH.db.run("CREATE TABLE t (id INTEGER)");',
        ].join('\n'),
      ),
    ],
    POLICY,
  );
  const f = findings.find((x) => x.rule === 'vch-sdk-not-loaded');
  assert.ok(f, 'debe detectar uso de VCH.db sin SDK cargado');
  assert.equal(f.severity, 'high');
  assert.equal(f.file, 'js/app.js');
  assert.equal(verdictFromFindings(findings, POLICY), 'rejected');
});

test('VCH.db con /db/sdk.js cargado no genera hallazgo', () => {
  const { findings } = scanBundle(
    [
      entry('app.json', VALID_MANIFEST),
      entry(
        'index.html',
        '<html><head><script src="/db/sdk.js"></script><script src="js/app.js" defer></script></head><body></body></html>',
      ),
      entry('js/app.js', 'await VCH.db.run("CREATE TABLE t (id INTEGER)");'),
    ],
    POLICY,
  );
  assert.ok(!findings.some((x) => x.rule === 'vch-sdk-not-loaded'), JSON.stringify(findings));
  assert.equal(verdictFromFindings(findings, POLICY), 'published');
});
