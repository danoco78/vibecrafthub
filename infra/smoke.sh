#!/usr/bin/env bash
# Smoke test e2e del MVP contra el API local (PGlite + volúmenes temporales).
set -uo pipefail

cd "$(dirname "$0")/.."

TMP=$(mktemp -d /tmp/opencode/vch-smoke-XXXXXX)
export PGLITE_DIR="$TMP/pglite"
export BUNDLES_DIR="$TMP/bundles"
export PORT=3100
export LOG_LEVEL=error
export APPS_URL_TEMPLATE='http://localhost:3100/bundles/{slug}/'

node apps/api/dist/index.js >"$TMP/api.log" 2>&1 &
API_PID=$!
cleanup() { kill "$API_PID" 2>/dev/null || true; rm -rf "$TMP"; }
trap cleanup EXIT

for _ in $(seq 1 40); do
  curl -sf "http://localhost:$PORT/healthz" >/dev/null 2>&1 && break
  sleep 0.25
done

BASE="http://localhost:$PORT"
JAR_ADMIN="$TMP/admin.txt"
JAR_DEV="$TMP/dev.txt"
PASS=0
FAIL=0

expect_eq() { # expect_eq <nombre> <actual> <esperado>
  if [ "$2" = "$3" ]; then
    PASS=$((PASS + 1)); echo "  ok    $1"
  else
    FAIL=$((FAIL + 1)); echo "  FALLO $1 (obtuve: '$2', esperaba: '$3')"
  fi
}

json_field() { python3 -c "import json,sys; d=json.load(sys.stdin); print(eval(sys.argv[1]))" "$1"; }

echo "== salud =="
expect_eq "healthz responde" "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/healthz")" "200"

echo "== registro: primer usuario = admin =="
expect_eq "rol del primer usuario" \
  "$(curl -s -c "$JAR_ADMIN" -H 'Content-Type: application/json' \
      -d '{"email":"admin@empresa.com","password":"secreto123"}' \
      "$BASE/api/auth/register" | json_field "d['user']['role']")" "admin"

echo "== control de acceso sin sesión =="
expect_eq "GET /api/apps sin sesión 401" \
  "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/apps")" "401"
expect_eq "bundles sin sesión 401" \
  "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/bundles/loquesea/index.html")" "401"
expect_eq "auth/check sin sesión 401" \
  "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/auth/check")" "401"

echo "== admin gestiona usuarios =="
expect_eq "admin crea developer" \
  "$(curl -s -b "$JAR_ADMIN" -H 'Content-Type: application/json' \
      -d '{"email":"dev@empresa.com","password":"devpass123","role":"developer"}' \
      "$BASE/api/admin/users" | json_field "d['user']['role']")" "developer"
curl -s -c "$JAR_DEV" -H 'Content-Type: application/json' \
  -d '{"email":"dev@empresa.com","password":"devpass123"}' "$BASE/api/auth/login" >/dev/null

echo "== crear app =="
SLUG=$(curl -s -b "$JAR_DEV" -H 'Content-Type: application/json' \
  -d '{"name":"Inventario Oficina","description":"prueba"}' "$BASE/api/apps" \
  | json_field "d['app']['slug']")
expect_eq "slug generado" "$SLUG" "inventario-oficina"

echo "== bundle válido publica =="
mkdir -p "$TMP/bueno"
printf '%s' '{"name":"Inventario Oficina","version":"1.0.0","entrypoint":"index.html"}' > "$TMP/bueno/app.json"
printf '%s' '<!doctype html><html><body><h1>Inventario</h1><script src="app.js"></script></body></html>' > "$TMP/bueno/index.html"
printf '%s' "console.log('hola');" > "$TMP/bueno/app.js"
python3 - <<PYEOF
import zipfile
z = zipfile.ZipFile("$TMP/bueno.zip", "w")
for n in ("app.json", "index.html", "app.js"):
    z.write("$TMP/bueno/" + n, n)
z.close()
PYEOF
PUB=$(curl -s -b "$JAR_DEV" -F "bundle=@$TMP/bueno.zip" "$BASE/api/apps/$SLUG/publish")
expect_eq "veredicto y versión" \
  "$(echo "$PUB" | json_field "d['verdict'] + ' ' + d.get('version','')")" "published 1.0.0"

echo "== bundle con eval y secret es rechazado con reporte =="
mkdir -p "$TMP/malo"
printf '%s' '{"name":"Inventario Oficina","version":"1.1.0","entrypoint":"index.html"}' > "$TMP/malo/app.json"
printf '%s' '<!doctype html><html><body></body></html>' > "$TMP/malo/index.html"
printf '%s' "const r = eval(entrada);\nconst k = 'sk-abcdefghij0123456789abcdefghij';" > "$TMP/malo/app.js"
python3 - <<PYEOF
import zipfile
z = zipfile.ZipFile("$TMP/malo.zip", "w")
for n in ("app.json", "index.html", "app.js"):
    z.write("$TMP/malo/" + n, n)
z.close()
PYEOF
REJ=$(curl -s -b "$JAR_DEV" -F "bundle=@$TMP/malo.zip" "$BASE/api/apps/$SLUG/publish")
expect_eq "veredicto rechazado" "$(echo "$REJ" | json_field "d['verdict']")" "rejected"
expect_eq "hallazgos críticos detectados" \
  "$(echo "$REJ" | json_field "sum(1 for f in d['findings'] if f['rule'] in ('no-eval','secret-openai-key'))")" "2"
expect_eq "reporte incluye archivo y línea" \
  "$(echo "$REJ" | json_field "[(f['file'], f['line']) for f in d['findings'] if f['rule']=='no-eval']")" "[('app.js', 1)]"

echo "== versión duplicada se rechaza =="
DUP=$(curl -s -b "$JAR_DEV" -F "bundle=@$TMP/bueno.zip" "$BASE/api/apps/$SLUG/publish")
expect_eq "rechazo por duplicada" \
  "$(echo "$DUP" | json_field "d['verdict'] + ' ' + str(any(f['rule']=='manifest-version-exists' for f in d['findings']))")" \
  "rejected True"

echo "== bundle publicado se sirve con sesión =="
BODY=$(curl -s -b "$JAR_DEV" "$BASE/bundles/$SLUG/index.html")
case "$BODY" in *Inventario*) expect_eq "sirve index.html activo" "ok" "ok";; *) expect_eq "sirve index.html activo" "vacio" "ok";; esac

echo "== historial registra todos los intentos =="
expect_eq "3 intentos registrados (admin ve todos)" \
  "$(curl -s -b "$JAR_ADMIN" "$BASE/api/attempts" | json_field "len(d['attempts'])")" "3"
ATTEMPT_ID=$(curl -s -b "$JAR_DEV" "$BASE/api/attempts" | json_field "d['attempts'][0]['id']")
expect_eq "detalle de intento incluye findings" \
  "$(curl -s -b "$JAR_DEV" "$BASE/api/attempts/$ATTEMPT_ID" | json_field "len(d['attempt']['findings']) > 0")" "True"

echo
echo "== resultado: $PASS ok, $FAIL fallos =="
if [ "$FAIL" = "0" ]; then exit 0; else exit 1; fi
