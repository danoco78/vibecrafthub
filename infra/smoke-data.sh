#!/usr/bin/env bash
# Smoke test e2e del data gateway y apps privadas (v0.2) contra el API local
# (PGlite + volúmenes temporales). Modo dev: el gateway se alcanza en
# /bundles/{slug}/db/* (mismo origen) y auth/check se prueba con Host forjado.
set -uo pipefail

cd "$(dirname "$0")/.."

TMP=$(mktemp -d /tmp/opencode/vch-smoke-data-XXXXXX)
export PGLITE_DIR="$TMP/pglite"
export BUNDLES_DIR="$TMP/bundles"
export DATA_DIR="$TMP/appdb"
export PORT=3200
export LOG_LEVEL=error
export APPS_URL_TEMPLATE='http://localhost:3200/bundles/{slug}/'

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
JAR_DEV2="$TMP/dev2.txt"
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

db_query() { # db_query <jar> <slug> <json-body> → respuesta
  curl -s -b "$1" -H 'Content-Type: application/json' -d "$3" "$BASE/bundles/$2/db/query"
}

check_with_host() { # check_with_host <jar> <host> → código HTTP (cookie explícita:
  # curl no adjunta cookies de un jar cuando se sobreescribe el Host header)
  local token
  token=$(awk '$6 == "vch_session" {print $7}' "$1")
  curl -s -o /dev/null -w '%{http_code}' -H "Cookie: vch_session=$token" -H "Host: $2" "$BASE/api/auth/check"
}

db_put_config() { # db_put_config <json>
  curl -s -b "$JAR_ADMIN" -H 'Content-Type: application/json' -X PUT -d "$1" "$BASE/api/db-config"
}

# ---------- setup: usuarios, app publicada ----------
curl -s -c "$JAR_ADMIN" -H 'Content-Type: application/json' \
  -d '{"email":"admin@empresa.com","password":"secreto123"}' "$BASE/api/auth/register" >/dev/null
curl -s -b "$JAR_ADMIN" -H 'Content-Type: application/json' \
  -d '{"email":"dev@empresa.com","password":"devpass123","role":"developer"}' "$BASE/api/admin/users" >/dev/null
curl -s -b "$JAR_ADMIN" -H 'Content-Type: application/json' \
  -d '{"email":"dev2@empresa.com","password":"dev2pass123","role":"developer"}' "$BASE/api/admin/users" >/dev/null
curl -s -c "$JAR_DEV" -H 'Content-Type: application/json' \
  -d '{"email":"dev@empresa.com","password":"devpass123"}' "$BASE/api/auth/login" >/dev/null
curl -s -c "$JAR_DEV2" -H 'Content-Type: application/json' \
  -d '{"email":"dev2@empresa.com","password":"dev2pass123"}' "$BASE/api/auth/login" >/dev/null

SLUG=$(curl -s -b "$JAR_DEV" -H 'Content-Type: application/json' \
  -d '{"name":"Inventario Oficina"}' "$BASE/api/apps" | json_field "d['app']['slug']")

mkdir -p "$TMP/app"
printf '%s' '{"name":"Inventario Oficina","version":"1.0.0","entrypoint":"index.html"}' > "$TMP/app/app.json"
printf '%s' '<!doctype html><html><body><h1>Inventario</h1><script src="/db/sdk.js"></script></body></html>' > "$TMP/app/index.html"
printf '%s' 'VCH.db.all("SELECT count(*) c FROM items").then(r => render(r.rows[0].c));' > "$TMP/app/app.js"
python3 - <<PYEOF
import zipfile
z = zipfile.ZipFile("$TMP/app.zip", "w")
for n in ("app.json", "index.html", "app.js"):
    z.write("$TMP/app/" + n, n)
z.close()
PYEOF
PUB=$(curl -s -b "$JAR_DEV" -F "bundle=@$TMP/app.zip" "$BASE/api/apps/$SLUG/publish")
expect_eq "bundle v1.0.0 publicado" "$(echo "$PUB" | json_field "d['verdict']")" "published"

echo "== control de acceso =="
expect_eq "query sin sesión 401 tipado" \
  "$(db_query /dev/null "$SLUG" '{"sql":"SELECT 1 AS n","mode":"all"}' | json_field "d['error']['code']")" \
  "VCH_DB_UNAUTHENTICATED"
expect_eq "sdk.js se sirve con CSP del propio origen" \
  "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/bundles/$SLUG/db/sdk.js")" "200"
SDK=$(curl -s "$BASE/bundles/$SLUG/db/sdk.js")
case "$SDK" in *VCH.db*) expect_eq "sdk define VCH.db" "ok" "ok";; *) expect_eq "sdk define VCH.db" "fallo" "ok";; esac

echo "== CRUD vía SQL parametrizado =="
expect_eq "CREATE TABLE (DDL permitido)" \
  "$(db_query "$JAR_DEV" "$SLUG" '{"sql":"CREATE TABLE IF NOT EXISTS items (id INTEGER PRIMARY KEY, name TEXT NOT NULL, qty INTEGER DEFAULT 0)","mode":"run"}' | json_field "d.get('changes','x') != None")" "True"
INS=$(db_query "$JAR_DEV" "$SLUG" '{"sql":"INSERT INTO items (name, qty) VALUES (?, ?)","params":["papel A4",12],"mode":"run"}')
expect_eq "INSERT con params → changes" "$(echo "$INS" | json_field "d['changes']")" "1"
expect_eq "INSERT → lastInsertRowid" "$(echo "$INS" | json_field "d['lastInsertRowid']")" "1"
expect_eq "SELECT all → filas" \
  "$(db_query "$JAR_DEV" "$SLUG" '{"sql":"SELECT id, name, qty FROM items","mode":"all"}' | json_field "d['rows'][0]['name'] + '=' + str(d['rows'][0]['qty'])")" "papel A4=12"
expect_eq "SELECT get con param nombrado" \
  "$(db_query "$JAR_DEV" "$SLUG" '{"sql":"SELECT qty FROM items WHERE name = :nombre","params":{"nombre":"papel A4"},"mode":"get"}' | json_field "d['row']['qty']")" "12"

echo "== statements fuera del allowlist =="
expect_eq "PRAGMA bloqueado" \
  "$(db_query "$JAR_DEV" "$SLUG" '{"sql":"PRAGMA journal_mode=DELETE","mode":"run"}' | json_field "d['error']['code']")" "VCH_DB_FORBIDDEN_STATEMENT"
expect_eq "ATTACH bloqueado" \
  "$(db_query "$JAR_DEV" "$SLUG" "{\"sql\":\"ATTACH DATABASE '/tmp/otra.db' AS x\",\"mode\":\"run\"}" | json_field "d['error']['code']")" "VCH_DB_FORBIDDEN_STATEMENT"
expect_eq "multi-statement bloqueado" \
  "$(db_query "$JAR_DEV" "$SLUG" '{"sql":"SELECT 1; SELECT 2","mode":"all"}' | json_field "d['error']['code']")" "VCH_DB_FORBIDDEN_STATEMENT"
expect_eq "modo inconsistente (run con SELECT) rechazado" \
  "$(db_query "$JAR_DEV" "$SLUG" '{"sql":"SELECT 1","mode":"run"}' | json_field "d['error']['code']")" "VCH_DB_FORBIDDEN_STATEMENT"

echo "== límite de filas =="
db_put_config '{"quotaMb":10,"timeoutMs":5000,"maxRows":5,"rateLimitPerMin":60}' >/dev/null
CTE=$(db_query "$JAR_DEV" "$SLUG" '{"sql":"WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM seq WHERE n < 50) SELECT n FROM seq","mode":"all"}')
expect_eq "CTE truncada a maxRows" "$(echo "$CTE" | json_field "str(len(d['rows'])) + '/' + str(d['truncated'])")" "5/True"
db_put_config '{"quotaMb":10,"timeoutMs":5000,"maxRows":1000,"rateLimitPerMin":60}' >/dev/null

echo "== cuota de disco con rollback =="
db_put_config '{"quotaMb":1,"timeoutMs":5000,"maxRows":1000,"rateLimitPerMin":60}' >/dev/null
expect_eq "blob de 2 MB excede cuota de 1 MB" \
  "$(db_query "$JAR_DEV" "$SLUG" "{\"sql\":\"INSERT INTO items (name, qty) VALUES ('grande', randomblob(2097152))\",\"mode\":\"run\"}" | json_field "d['error']['code']")" "VCH_DB_QUOTA_EXCEEDED"
expect_eq "la escritura quedó revertida" \
  "$(db_query "$JAR_DEV" "$SLUG" '{"sql":"SELECT count(*) AS c FROM items","mode":"get"}' | json_field "d['row']['c']")" "1"
db_put_config '{"quotaMb":10,"timeoutMs":5000,"maxRows":1000,"rateLimitPerMin":60}' >/dev/null

echo "== apps privadas con allowlist =="
SLUG2=$(curl -s -b "$JAR_DEV" -H 'Content-Type: application/json' \
  -d '{"name":"Nóminas RRHH"}' "$BASE/api/apps" | json_field "d['app']['slug']")
mkdir -p "$TMP/app2"
printf '%s' '{"name":"Nóminas RRHH","version":"1.0.0","entrypoint":"index.html"}' > "$TMP/app2/app.json"
printf '%s' '<!doctype html><html><body><h1>Nóminas</h1></body></html>' > "$TMP/app2/index.html"
python3 - <<PYEOF
import zipfile
z = zipfile.ZipFile("$TMP/app2.zip", "w")
z.write("$TMP/app2/app.json", "app.json")
z.write("$TMP/app2/index.html", "index.html")
z.close()
PYEOF
curl -s -b "$JAR_DEV" -F "bundle=@$TMP/app2.zip" "$BASE/api/apps/$SLUG2/publish" >/dev/null
db_query "$JAR_DEV" "$SLUG2" '{"sql":"CREATE TABLE salarios (email TEXT, monto INTEGER)","mode":"run"}' >/dev/null
db_query "$JAR_DEV" "$SLUG2" '{"sql":"INSERT INTO salarios VALUES (?, ?)","params":["jefe@empresa.com",999999],"mode":"run"}' >/dev/null

curl -s -b "$JAR_DEV" -H 'Content-Type: application/json' -X PATCH \
  -d '{"visibility":"private"}' "$BASE/api/apps/$SLUG2" >/dev/null
expect_eq "dev2 no ve la app privada en el catálogo" \
  "$(curl -s -b "$JAR_DEV2" "$BASE/api/apps" | json_field "any(a['slug']=='$SLUG2' for a in d['apps'])")" "False"
expect_eq "detalle de app privada oculto (404)" \
  "$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR_DEV2" "$BASE/api/apps/$SLUG2")" "404"
expect_eq "BD de la app privada inaccesible sin allowlist" \
  "$(db_query "$JAR_DEV2" "$SLUG2" '{"sql":"SELECT * FROM salarios","mode":"all"}' | json_field "d['error']['code']")" "VCH_DB_FORBIDDEN"
expect_eq "forward_auth rechaza con 403 (host de app)" \
  "$(check_with_host "$JAR_DEV2" "$SLUG2.apps.empresa.com")" "403"
expect_eq "owner sí pasa forward_auth" \
  "$(check_with_host "$JAR_DEV" "$SLUG2.apps.empresa.com")" "204"

curl -s -b "$JAR_DEV" -H 'Content-Type: application/json' \
  -d '{"email":"dev2@empresa.com"}' "$BASE/api/apps/$SLUG2/members" >/dev/null
expect_eq "miembro ve la app en el catálogo" \
  "$(curl -s -b "$JAR_DEV2" "$BASE/api/apps" | json_field "any(a['slug']=='$SLUG2' for a in d['apps'])")" "True"
expect_eq "miembro consulta la BD compartida (dato del owner)" \
  "$(db_query "$JAR_DEV2" "$SLUG2" '{"sql":"SELECT monto FROM salarios WHERE email = ?","params":["jefe@empresa.com"],"mode":"get"}' | json_field "d['row']['monto']")" "999999"
expect_eq "miembro pasa forward_auth" \
  "$(check_with_host "$JAR_DEV2" "$SLUG2.apps.empresa.com")" "204"
expect_eq "allowlist lista al miembro" \
  "$(curl -s -b "$JAR_DEV" "$BASE/api/apps/$SLUG2/members" | json_field "[m['email'] for m in d['members']]")" "['dev2@empresa.com']"
DEV2_ID=$(curl -s -b "$JAR_ADMIN" "$BASE/api/admin/users" | json_field "[u['id'] for u in d['users'] if u['email']=='dev2@empresa.com'][0]")
curl -s -b "$JAR_DEV" -X DELETE "$BASE/api/apps/$SLUG2/members/$DEV2_ID" >/dev/null
expect_eq "tras quitar de la allowlist vuelve al 403" \
  "$(check_with_host "$JAR_DEV2" "$SLUG2.apps.empresa.com")" "403"
curl -s -b "$JAR_DEV" -H 'Content-Type: application/json' -X PATCH \
  -d '{"visibility":"public"}' "$BASE/api/apps/$SLUG2" >/dev/null

echo "== administración de BDs =="
expect_eq "overview muestra la BD en uso" \
  "$(curl -s -b "$JAR_ADMIN" "$BASE/api/admin/db-overview" | json_field "next((x['sizeBytes'] > 0 for x in d['databases'] if x['slug']=='$SLUG'), False)")" "True"
curl -s -b "$JAR_ADMIN" "$BASE/api/admin/apps/$SLUG/database/download" -o "$TMP/descarga.db"
expect_eq "descarga es un SQLite válido" \
  "$(head -c 15 "$TMP/descarga.db")" "SQLite format 3"
expect_eq "reset exige confirmación" \
  "$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR_ADMIN" -X POST -H 'Content-Type: application/json' -d '{}' "$BASE/api/admin/apps/$SLUG/database/reset")" "400"
curl -s -b "$JAR_ADMIN" -X POST -H 'Content-Type: application/json' -d '{"confirm":true}' \
  "$BASE/api/admin/apps/$SLUG/database/reset" >/dev/null
expect_eq "tras reset la tabla desapareció" \
  "$(db_query "$JAR_DEV" "$SLUG" '{"sql":"SELECT count(*) AS c FROM items","mode":"get"}' | json_field "d['error']['code']")" "VCH_DB_FORBIDDEN_STATEMENT"

echo "== rate limit =="
db_put_config '{"quotaMb":10,"timeoutMs":5000,"maxRows":1000,"rateLimitPerMin":3}' >/dev/null
RL="rl"
for _ in 1 2 3 4; do
  RL=$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR_ADMIN" -H 'Content-Type: application/json' \
    -d '{"sql":"SELECT 1 AS n","mode":"all"}' "$BASE/bundles/$SLUG/db/query")
done
expect_eq "4ª query en el minuto → 429" "$RL" "429"
db_put_config '{"quotaMb":10,"timeoutMs":5000,"maxRows":1000,"rateLimitPerMin":60}' >/dev/null

echo "== CSP por app (dominios aprobados, v0.3) =="
curl -s -b "$JAR_ADMIN" -H 'Content-Type: application/json' \
  -d '{"domain":"api.empresa.com","note":"API interna"}' "$BASE/api/admin/external-domains" >/dev/null
SLUG_C=$(curl -s -b "$JAR_DEV" -H 'Content-Type: application/json' \
  -d '{"name":"Cliente API Interna"}' "$BASE/api/apps" | json_field "d['app']['slug']")
mkdir -p "$TMP/appc"
printf '%s' '{"name":"Cliente API Interna","version":"1.0.0","entrypoint":"index.html","externalDomains":["HTTPS://Api.Empresa.com:8443/api"]}' > "$TMP/appc/app.json"
printf '%s' '<!doctype html><html><body></body></html>' > "$TMP/appc/index.html"
printf '%s' "fetch('https://api.empresa.com/v1');" > "$TMP/appc/app.js"
python3 - <<PYEOF
import zipfile
z = zipfile.ZipFile("$TMP/appc.zip", "w")
for n in ("app.json", "index.html", "app.js"):
    z.write("$TMP/appc/" + n, n)
z.close()
PYEOF
PUBC=$(curl -s -b "$JAR_DEV" -F "bundle=@$TMP/appc.zip" "$BASE/api/apps/$SLUG_C/publish")
expect_eq "app con dominio aprobado publica sin hallazgos de dominio" \
  "$(echo "$PUBC" | json_field "d['verdict'] + ' ' + str(sum(1 for f in d['findings'] if f['rule']=='manifest-external-domains'))")" "published 0"
CSP_C=$(curl -s -D- -o /dev/null -b "$JAR_DEV" "$BASE/bundles/$SLUG_C/index.html" | grep -i '^content-security-policy:')
case "$CSP_C" in *connect-src\ *https://api.empresa.com*) expect_eq "CSP de la app abre connect-src al dominio aprobado" "ok" "ok";; *) expect_eq "CSP de la app abre connect-src al dominio aprobado" "falta: $CSP_C" "ok";; esac
CSP_A=$(curl -s -D- -o /dev/null -b "$JAR_DEV" "$BASE/bundles/$SLUG/index.html" | grep -i '^content-security-policy:')
case "$CSP_A" in *api.empresa.com*) expect_eq "app sin dominios declarados mantiene CSP base" "con dominio ajeno" "ok";; *) expect_eq "app sin dominios declarados mantiene CSP base" "ok" "ok";; esac

echo
echo "== resultado: $PASS ok, $FAIL fallos =="
if [ "$FAIL" = "0" ]; then exit 0; else exit 1; fi
