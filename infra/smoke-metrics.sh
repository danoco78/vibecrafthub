#!/usr/bin/env bash
# Smoke test v1.0: métricas de uso y export de auditoría.
# Genera actividad real (logins ok/fail, publicación ok y rechazada, accesos,
# queries ok/error), fuerza el flush del collector con SIGTERM y valida los
# endpoints de métricas y los exports de auditoría (CSV/JSON con filtros).
set -uo pipefail

cd "$(dirname "$0")/.."

TMP=$(mktemp -d /tmp/opencode/vch-metrics-XXXXXX)
export PGLITE_DIR="$TMP/pg" BUNDLES_DIR="$TMP/b" DATA_DIR="$TMP/d" PORT=3960 LOG_LEVEL=error

start_api() {
  node apps/api/dist/index.js >>"$TMP/log" 2>&1 &
  API_PID=$!
  for _ in $(seq 1 40); do curl -sf "http://localhost:$PORT/healthz" >/dev/null 2>&1 && break; sleep 0.25; done
}
start_api
cleanup() { kill "$API_PID" 2>/dev/null || true; rm -rf "$TMP"; }
trap cleanup EXIT

BASE="http://localhost:$PORT"
JAR="$TMP/j.txt"; JDEV="$TMP/d.txt"
PASS=0; FAIL=0
expect_eq() { if [ "$2" = "$3" ]; then PASS=$((PASS+1)); echo "  ok    $1"; else FAIL=$((FAIL+1)); echo "  FALLO $1 (obtuve: '$2', esperaba: '$3')"; fi }
py() { python3 -c "import json,sys; d=json.load(open(sys.argv[1])); print(eval(sys.argv[2]))" "$1" "$2"; }

curl -s -c "$JAR" -H 'Content-Type: application/json' -d '{"email":"admin@empresa.com","password":"secreto123"}' "$BASE/api/auth/register" >/dev/null
curl -s -b "$JAR" -H 'Content-Type: application/json' -d '{"email":"dev@empresa.com","password":"devpass123","role":"developer"}' "$BASE/api/admin/users" >/dev/null
curl -s -H 'Content-Type: application/json' -d '{"email":"admin@empresa.com","password":"mala"}' "$BASE/api/auth/login" >/dev/null
curl -s -c "$JDEV" -H 'Content-Type: application/json' -d '{"email":"dev@empresa.com","password":"devpass123"}' "$BASE/api/auth/login" >/dev/null

mk_app() { # mk_app <nombre> <code.js> → publica y deja el slug en $SLUG
  SLUG=$(curl -s -b "$JDEV" -H 'Content-Type: application/json' -d "{\"name\":\"$1\"}" "$BASE/api/apps" | python3 -c "import json,sys; print(json.load(sys.stdin)['app']['slug'])")
  mkdir -p "$TMP/$SLUG"
  printf '%s' "{\"name\":\"$1\",\"version\":\"1.0.0\",\"entrypoint\":\"index.html\"}" > "$TMP/$SLUG/app.json"
  printf '%s' '<!doctype html><html><body></body></html>' > "$TMP/$SLUG/index.html"
  printf '%s' "$2" > "$TMP/$SLUG/code.js"
  python3 -c "
import zipfile
z = zipfile.ZipFile('$TMP/$SLUG.zip','w')
[ z.write('$TMP/$SLUG/'+n, n) for n in ('app.json','index.html','code.js') ]
z.close()"
  curl -s -b "$JDEV" -F "bundle=@$TMP/$SLUG.zip" "$BASE/api/apps/$SLUG/publish" >/dev/null
}

mk_app "Con Metricas" "console.log('ok');"
curl -s -o /dev/null -b "$JDEV" "$BASE/bundles/$SLUG/index.html"
curl -s -o /dev/null -b "$JDEV" "$BASE/bundles/$SLUG/index.html"
curl -s -b "$JDEV" -H 'Content-Type: application/json' -d '{"sql":"SELECT 1 AS n","mode":"all"}' "$BASE/bundles/$SLUG/db/query" >/dev/null
curl -s -b "$JDEV" -H 'Content-Type: application/json' -d '{"sql":"SELECT * FROM noexiste","mode":"all"}' "$BASE/bundles/$SLUG/db/query" >/dev/null
mk_app "Con Eval" "const r = eval(entrada);"

echo "== flush y reinicio (SIGTERM) =="
kill -TERM "$API_PID"; sleep 1
start_api

echo "== métricas agregadas =="
curl -s -b "$JAR" "$BASE/api/admin/metrics?days=7" >"$TMP/m.json"
expect_eq "loginOkLocal=1 (el registro no es login)" "$(py "$TMP/m.json" "d['summary']['loginOkLocal']")" "1"
expect_eq "loginFail=1" "$(py "$TMP/m.json" "d['summary']['loginFail']")" "1"
expect_eq "publishOk=1" "$(py "$TMP/m.json" "d['summary']['publishOk']")" "1"
expect_eq "publishRejected=1" "$(py "$TMP/m.json" "d['summary']['publishRejected']")" "1"
expect_eq "dbQueries=2 (ok + error)" "$(py "$TMP/m.json" "d['summary']['dbQueries']")" "2"
expect_eq "appAccess=2" "$(py "$TMP/m.json" "d['summary']['appAccess']")" "2"
expect_eq "tabla por app con acceso 2 y queries 2" \
  "$(python3 -c "import json; d=json.load(open('$TMP/m.json')); a=[x for x in d['apps'] if x['slug']=='con-metricas']; print(a[0]['access'], a[0]['dbQueries'])")" \
  "2 2"

echo "== permisos =="
expect_eq "developer no ve métricas → 403" \
  "$(curl -s -o /dev/null -w '%{http_code}' -b "$JDEV" "$BASE/api/admin/metrics?days=7")" "403"

echo "== export CSV de métricas =="
curl -s -b "$JAR" "$BASE/api/admin/metrics/export?days=30" >"$TMP/mx.csv"
expect_eq "cabecera" "$(head -1 "$TMP/mx.csv")" "day,metric,key,value"
expect_eq "7 filas (login.ok/fail, publish.ok/rejected, dbquery.ok/error, appaccess)" \
  "$(tail -n +2 "$TMP/mx.csv" | wc -l)" "7"

echo "== export de auditoría: publicaciones =="
TODAY=$(date +%F)
curl -s -b "$JAR" "$BASE/api/admin/audit/export?type=publishes&from=2020-01-01&to=$TODAY&format=csv" >"$TMP/aud.csv"
expect_eq "cabecera" "$(head -1 "$TMP/aud.csv")" \
  "id,fecha,app_slug,app_name,usuario,veredicto,version,bundle_hash,total_hallazgos,hallazgos"
expect_eq "2 intentos (uno por app)" "$(tail -n +2 "$TMP/aud.csv" | wc -l)" "2"
expect_eq "la rechazada con hallazgos (no-eval)" "$(grep -c 'no-eval' "$TMP/aud.csv")" "1"
curl -s -b "$JAR" "$BASE/api/admin/audit/export?type=publishes&from=2020-01-01&to=$TODAY&format=json" >"$TMP/aud.json"
expect_eq "JSON total=2" "$(py "$TMP/aud.json" "d['total']")" "2"
expect_eq "hallazgos expandidos" "$(python3 -c "import json; d=json.load(open('$TMP/aud.json')); r=[x for x in d['registros'] if x['veredicto']=='rejected'][0]; print(len(r['hallazgos']), r['hallazgos'][0]['rule'])")" "1 no-eval"

echo "== export de auditoría: acciones y filtros =="
curl -s -b "$JAR" "$BASE/api/admin/audit/export?type=actions&from=2020-01-01&to=$TODAY&format=json" >"$TMP/act.json"
expect_eq "alta de usuario auditada" "$(py "$TMP/act.json" "str(d['total'] >= 1) + ' ' + d['registros'][0]['accion']")" "True user.create"
expect_eq "filtro por app: solo 1 intento" \
  "$(curl -s -b "$JAR" "$BASE/api/admin/audit/export?type=publishes&from=2020-01-01&to=$TODAY&slug=con-metricas&format=json" | python3 -c "import json,sys; print(json.load(sys.stdin)['total'])")" "1"

echo "== permisos y robustez =="
expect_eq "developer no exporta auditoría → 403" \
  "$(curl -s -o /dev/null -w '%{http_code}' -b "$JDEV" "$BASE/api/admin/audit/export?type=publishes&format=csv")" "403"
expect_eq "fecha malformada se ignora (2 intentos)" \
  "$(curl -s -b "$JAR" "$BASE/api/admin/audit/export?type=publishes&from=xxx&format=json" | python3 -c "import json,sys; print(json.load(sys.stdin)['total'])")" "2"

echo
echo "== resultado: $PASS ok, $FAIL fallos =="
if [ "$FAIL" = "0" ]; then exit 0; else exit 1; fi
