#!/usr/bin/env bash
# Smoke test de los huecos menores: cambio de contraseña, desactivación de
# usuarios, reset admin, rate limiting de login y borrado de apps.
set -uo pipefail

cd "$(dirname "$0")/.."

TMP=$(mktemp -d /tmp/opencode/vch-acct-XXXXXX)
export PGLITE_DIR="$TMP/pglite"
export BUNDLES_DIR="$TMP/bundles"
export PORT=3600
export LOG_LEVEL=error

node apps/api/dist/index.js >"$TMP/api.log" 2>&1 &
API_PID=$!
cleanup() { kill "$API_PID" 2>/dev/null || true; rm -rf "$TMP"; }
trap cleanup EXIT

for _ in $(seq 1 40); do
  curl -sf "http://localhost:$PORT/healthz" >/dev/null 2>&1 && break
  sleep 0.25
done

BASE="http://localhost:$PORT"
PASS=0; FAIL=0
expect_eq() {
  if [ "$2" = "$3" ]; then PASS=$((PASS+1)); echo "  ok    $1"
  else FAIL=$((FAIL+1)); echo "  FALLO $1 (obtuve: '$2', esperaba: '$3')"; fi
}
jf() { python3 -c "import json,sys; d=json.load(sys.stdin); print(eval(sys.argv[1]))" "$1"; }

echo "== setup: admin + developer =="
JAR_A="$TMP/admin.txt"; JAR_D="$TMP/dev.txt"
curl -s -c "$JAR_A" -H 'Content-Type: application/json' -d '{"email":"admin@t.com","password":"clave123"}' "$BASE/api/auth/register" -o /dev/null
curl -s -b "$JAR_A" -H 'Content-Type: application/json' -d '{"email":"dev@t.com","password":"devpass123","role":"developer"}' "$BASE/api/admin/users" -o /dev/null
curl -s -c "$JAR_D" -H 'Content-Type: application/json' -d '{"email":"dev@t.com","password":"devpass123"}' "$BASE/api/auth/login" -o /dev/null
DEV_ID=$(curl -s -b "$JAR_A" "$BASE/api/admin/users" | jf "[u['id'] for u in d['users'] if u['email']=='dev@t.com'][0]")

echo "== cambio de contraseña (autogestionado) =="
expect_eq "contraseña actual incorrecta → 400" \
  "$(curl -s -b "$JAR_D" -o /dev/null -w '%{http_code}' -H 'Content-Type: application/json' -d '{"currentPassword":"malamala","newPassword":"nueva1234"}' "$BASE/api/auth/change-password")" "400"
expect_eq "cambio correcto → 200" \
  "$(curl -s -b "$JAR_D" -o /dev/null -w '%{http_code}' -H 'Content-Type: application/json' -d '{"currentPassword":"devpass123","newPassword":"nueva1234"}' "$BASE/api/auth/change-password")" "200"
expect_eq "login con la contraseña nueva funciona" \
  "$(curl -s -o /dev/null -w '%{http_code}' -H 'Content-Type: application/json' -d '{"email":"dev@t.com","password":"nueva1234"}' "$BASE/api/auth/login")" "200"

echo "== desactivación de usuario =="
expect_eq "no puedes desactivarte a ti mismo" \
  "$(curl -s -b "$JAR_A" -o /dev/null -w '%{http_code}' -X PUT -H 'Content-Type: application/json' -d '{"active":false}' "$BASE/api/admin/users/1/active")" "400"
expect_eq "admin desactiva al developer" \
  "$(curl -s -b "$JAR_A" -X PUT -H 'Content-Type: application/json' -d '{"active":false}' "$BASE/api/admin/users/$DEV_ID/active" | jf "d['user']['active']")" "False"
expect_eq "login de cuenta desactivada → 403" \
  "$(curl -s -o /dev/null -w '%{http_code}' -H 'Content-Type: application/json' -d '{"email":"dev@t.com","password":"nueva1234"}' "$BASE/api/auth/login")" "403"
expect_eq "sesión previa del desactivado queda muerta" \
  "$(curl -s -b "$JAR_D" "$BASE/api/auth/me" | jf "d['user']")" "None"
expect_eq "reactivación funciona" \
  "$(curl -s -b "$JAR_A" -X PUT -H 'Content-Type: application/json' -d '{"active":true}' "$BASE/api/admin/users/$DEV_ID/active" | jf "d['user']['active']")" "True"

echo "== reset de contraseña por admin =="
expect_eq "admin restablece" \
  "$(curl -s -b "$JAR_A" -o /dev/null -w '%{http_code}' -H 'Content-Type: application/json' -d '{"newPassword":"resetpass1"}' "$BASE/api/admin/users/$DEV_ID/reset-password")" "200"
expect_eq "login con contraseña restablecida" \
  "$(curl -s -H 'Content-Type: application/json' -d '{"email":"dev@t.com","password":"resetpass1"}' "$BASE/api/auth/login" | jf "d['user']['role']")" "developer"
# el reset mató las sesiones previas: re-login para seguir probando como developer
curl -s -c "$JAR_D" -H 'Content-Type: application/json' -d '{"email":"dev@t.com","password":"resetpass1"}' "$BASE/api/auth/login" -o /dev/null

echo "== borrado de app =="
SLUG=$(curl -s -b "$JAR_D" -H 'Content-Type: application/json' -d '{"name":"App Efimera"}' "$BASE/api/apps" | jf "d['app']['slug']")
B="$TMP/b"; mkdir -p "$B"
printf '%s' '{"name":"App Efimera","version":"1.0.0","entrypoint":"index.html"}' > "$B/app.json"
printf '%s' '<html><body>efimera</body></html>' > "$B/index.html"
python3 -c "
import zipfile
z = zipfile.ZipFile('$TMP/b.zip','w')
for n in ('app.json','index.html'): z.write('$B/'+n, n)
"
curl -s -b "$JAR_D" -F "bundle=@$TMP/b.zip" "$BASE/api/apps/$SLUG/publish" -o /dev/null
expect_eq "app publicada accesible" \
  "$(curl -s -b "$JAR_D" -o /dev/null -w '%{http_code}' "$BASE/bundles/$SLUG/index.html")" "200"
expect_eq "borrar app" \
  "$(curl -s -b "$JAR_D" -o /dev/null -w '%{http_code}' -X DELETE "$BASE/api/apps/$SLUG")" "200"
expect_eq "app desaparece del API" \
  "$(curl -s -b "$JAR_D" -o /dev/null -w '%{http_code}' "$BASE/api/apps/$SLUG")" "404"
expect_eq "bundle borrado del volumen" \
  "$(curl -s -b "$JAR_D" -o /dev/null -w '%{http_code}' "$BASE/bundles/$SLUG/index.html")" "404"

echo "== rate limiting de login =="
for i in 1 2 3 4 5; do
  curl -s -o /dev/null -H 'Content-Type: application/json' -d '{"email":"brute@t.com","password":"equivocada"}' "$BASE/api/auth/login"
done
expect_eq "6º intento tras 5 fallos → 429" \
  "$(curl -s -o /dev/null -w '%{http_code}' -H 'Content-Type: application/json' -d '{"email":"brute@t.com","password":"cualquiera"}' "$BASE/api/auth/login")" "429"
expect_eq "otro email no afectado" \
  "$(curl -s -o /dev/null -w '%{http_code}' -H 'Content-Type: application/json' -d '{"email":"dev@t.com","password":"resetpass1"}' "$BASE/api/auth/login")" "200"

echo
echo "== resultado: $PASS ok, $FAIL fallos =="
if [ "$FAIL" = "0" ]; then exit 0; else exit 1; fi
