#!/usr/bin/env bash
# Smoke test de la etapa LLM: stub OpenAI-compatible + config admin + caché + onUnavailable.
set -uo pipefail

cd "$(dirname "$0")/.."

TMP=$(mktemp -d /tmp/opencode/vch-llm-XXXXXX)
export PGLITE_DIR="$TMP/pglite"
export BUNDLES_DIR="$TMP/bundles"
export PORT=3400
export LOG_LEVEL=error

node apps/api/dist/index.js >"$TMP/api.log" 2>&1 &
API_PID=$!

# Stub OpenAI-compatible: hallazgo crítico si el código contiene EVIL_MARKER, si no array vacío
node -e '
const http = require("http");
let calls = 0;
http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    calls++;
    const evil = body.includes("EVIL_MARKER");
    const content = evil
      ? JSON.stringify([{ severity: "critical", rule: "evil-code", line: 2, message: "Código marcado como malicioso", fix: "Elimina EVIL_MARKER" }])
      : "[]";
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ choices: [{ message: { content } }] }));
  });
}).listen(3456, () => console.log("stub listo"));
' >"$TMP/stub.log" 2>&1 &
STUB_PID=$!
cleanup() { kill "$API_PID" "$STUB_PID" 2>/dev/null || true; rm -rf "$TMP"; }
trap cleanup EXIT

for _ in $(seq 1 40); do
  curl -sf "http://localhost:$PORT/healthz" >/dev/null 2>&1 && break
  sleep 0.25
done

BASE="http://localhost:$PORT"
JAR="$TMP/jar.txt"
PASS=0; FAIL=0
expect_eq() {
  if [ "$2" = "$3" ]; then PASS=$((PASS+1)); echo "  ok    $1"
  else FAIL=$((FAIL+1)); echo "  FALLO $1 (obtuve: '$2', esperaba: '$3')"; fi
}
jf() { python3 -c "import json,sys; d=json.load(sys.stdin); print(eval(sys.argv[1]))" "$1"; }

echo "== setup: admin + app =="
curl -s -c "$JAR" -H 'Content-Type: application/json' -d '{"email":"admin@empresa.com","password":"secreto123"}' "$BASE/api/auth/register" -o /dev/null
SLUG=$(curl -s -b "$JAR" -H 'Content-Type: application/json' -d '{"name":"App LLM"}' "$BASE/api/apps" | jf "d['app']['slug']")
expect_eq "app creada" "$SLUG" "app-llm"

echo "== config LLM =="
expect_eq "endpoint exige admin" \
  "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/llm-config")" "401"
expect_eq "config inicial deshabilitada" \
  "$(curl -s -b "$JAR" "$BASE/api/llm-config" | jf "d['config']['enabled']")" "False"
expect_eq "PUT activa la revisión" \
  "$(curl -s -b "$JAR" -X PUT -H 'Content-Type: application/json' \
      -d '{"enabled":true,"provider":"openai","baseUrl":"http://localhost:3456/v1","model":"stub-1","apiKey":"sk-test-1234","onUnavailable":"continue"}' \
      "$BASE/api/llm-config" | jf "d['config']['enabled'] and d['config']['apiKeyMasked'].endswith('1234')")" "True"
expect_eq "la clave no se re-expone completa" \
  "$(curl -s -b "$JAR" "$BASE/api/llm-config" | jf "'sk-test-1234' not in json.dumps(d)")" "True"

echo "== publicación: hallazgo del LLM bloquea =="
B="$TMP/b1"; mkdir -p "$B"
printf '%s' '{"name":"App LLM","version":"1.0.0","entrypoint":"index.html"}' > "$B/app.json"
printf '%s' '<!doctype html><html><body></body></html>' > "$B/index.html"
printf '%s' "console.log('ok');\nconst x = 'EVIL_MARKER';" > "$B/app.js"
python3 -c "
import zipfile
z = zipfile.ZipFile('$TMP/b1.zip','w')
for n in ('app.json','index.html','app.js'): z.write('$B/'+n, n)
"
R1=$(curl -s -b "$JAR" -F "bundle=@$TMP/b1.zip" "$BASE/api/apps/$SLUG/publish")
expect_eq "rechazado por hallazgo LLM" "$(echo "$R1" | jf "d['verdict']")" "rejected"
expect_eq "hallazgo llm-evil-code con archivo y línea" \
  "$(echo "$R1" | jf "[(f['file'],f['line']) for f in d['findings'] if f['rule']=='llm-evil-code']")" "[('app.js', 2)]"
expect_eq "meta registra modelo y revisión" \
  "$(echo "$R1" | jf "d['meta']['llm']['model']=='stub-1' and d['meta']['llm']['reviewed']==3 and d['meta']['llm']['cached']==0")" "True"

echo "== caché: mismo archivo, otra versión no llama al stub =="
printf '%s' '{"name":"App LLM","version":"1.2.0","entrypoint":"index.html"}' > "$B/app.json"
rm -f "$TMP/b1.zip"
python3 -c "
import zipfile
z = zipfile.ZipFile('$TMP/b1.zip','w')
for n in ('app.json','index.html','app.js'): z.write('$B/'+n, n)
"
R2=$(curl -s -b "$JAR" -F "bundle=@$TMP/b1.zip" "$BASE/api/apps/$SLUG/publish")
expect_eq "hallazgo servido desde caché" \
  "$(echo "$R2" | jf "d['meta']['llm']['cached']==2 and d['meta']['llm']['reviewed']==1")" "True"
expect_eq "sigue rechazando (hallazgo cacheado)" "$(echo "$R2" | jf "d['verdict']")" "rejected"

echo "== LLM caído + política continue =="
curl -s -b "$JAR" -X PUT -H 'Content-Type: application/json' \
  -d '{"enabled":true,"provider":"openai","baseUrl":"http://localhost:9/v1","model":"stub-1","onUnavailable":"continue"}' \
  "$BASE/api/llm-config" -o /dev/null
printf '%s' '{"name":"App LLM","version":"1.3.0","entrypoint":"index.html"}' > "$B/app.json"
printf '%s' "console.log('limpio');" > "$B/app.js"
rm -f "$TMP/b1.zip"
python3 -c "
import zipfile
z = zipfile.ZipFile('$TMP/b1.zip','w')
for n in ('app.json','index.html','app.js'): z.write('$B/'+n, n)
"
R3=$(curl -s -b "$JAR" -F "bundle=@$TMP/b1.zip" "$BASE/api/apps/$SLUG/publish")
expect_eq "publica con advertencia informativa" \
  "$(echo "$R3" | jf "d['verdict']=='published' and any(f['rule']=='llm-unavailable' and f['severity']=='info' for f in d['findings'])")" "True"

echo "== LLM caído + política block =="
curl -s -b "$JAR" -X PUT -H 'Content-Type: application/json' \
  -d '{"enabled":true,"provider":"openai","baseUrl":"http://localhost:9/v1","model":"stub-1","onUnavailable":"block"}' \
  "$BASE/api/llm-config" -o /dev/null
printf '%s' '{"name":"App LLM","version":"1.4.0","entrypoint":"index.html"}' > "$B/app.json"
rm -f "$TMP/b1.zip"
python3 -c "
import zipfile
z = zipfile.ZipFile('$TMP/b1.zip','w')
for n in ('app.json','index.html','app.js'): z.write('$B/'+n, n)
"
R4=$(curl -s -b "$JAR" -F "bundle=@$TMP/b1.zip" "$BASE/api/apps/$SLUG/publish")
expect_eq "rechaza cuando la política exige bloquear" \
  "$(echo "$R4" | jf "d['verdict']=='rejected' and any(f['rule']=='llm-unavailable' and f['severity']=='critical' for f in d['findings'])")" "True"

echo "== bundle limpio con LLM vivo publica =="
curl -s -b "$JAR" -X PUT -H 'Content-Type: application/json' \
  -d '{"enabled":true,"provider":"openai","baseUrl":"http://localhost:3456/v1","model":"stub-1","onUnavailable":"block"}' \
  "$BASE/api/llm-config" -o /dev/null
printf '%s' '{"name":"App LLM","version":"1.5.0","entrypoint":"index.html"}' > "$B/app.json"
rm -f "$TMP/b1.zip"
python3 -c "
import zipfile
z = zipfile.ZipFile('$TMP/b1.zip','w')
for n in ('app.json','index.html','app.js'): z.write('$B/'+n, n)
"
R5=$(curl -s -b "$JAR" -F "bundle=@$TMP/b1.zip" "$BASE/api/apps/$SLUG/publish")
expect_eq "publicado sin hallazgos" "$(echo "$R5" | jf "d['verdict']=='published' and len(d['findings'])==0")" "True"

echo
echo "== resultado: $PASS ok, $FAIL fallos =="
if [ "$FAIL" = "0" ]; then exit 0; else exit 1; fi
