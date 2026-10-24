#!/usr/bin/env bash
# Smoke test v0.3: login corporativo contra un directorio LDAP real.
# Levanta glauth (LDAPS con certificado autofirmado) en podman y valida:
# test de conexión, JIT al primer login, roles por grupo, guards de
# contraseña y el comportamiento con el directorio caído.
# Requiere podman (o docker) y openssl.
set -uo pipefail

cd "$(dirname "$0")/.."

DOCKER="${DOCKER:-podman}"

TMP=$(mktemp -d /tmp/opencode/vch-ldap-XXXXXX)
openssl req -x509 -newkey rsa:2048 -keyout "$TMP/tls.key" -out "$TMP/tls.crt" -days 2 -nodes -subj "/CN=localhost" >/dev/null 2>&1
DEV_SHA=$(printf 'devpass123' | sha256sum | cut -d' ' -f1)
VIEW_SHA=$(printf 'viewpass123' | sha256sum | cut -d' ' -f1)
BIND_SHA=$(printf 'bindsecret' | sha256sum | cut -d' ' -f1)

# ---- directorio desechable (glauth): LDAPS + tlsSkipVerify en el conector ----
cat > "$TMP/glauth.cfg" <<EOF
listen = "0.0.0.0:3893"

[ldaps]
  listen = "0.0.0.0:3894"
  cert = "/certs/tls.crt"
  key = "/certs/tls.key"

[backend]
  datastore = "config"
  baseDN = "dc=empresa,dc=com"

[[users]]
  name = "svc-vch"
  uid = 5000
  primarygroup = 5500
  passsha256 = "$BIND_SHA"
  [[users.capabilities]]
    action = "search"
    object = "*"

[[users]]
  name = "maria"
  givenname = "Maria"
  sn = "Dev"
  mail = "maria@empresa.com"
  uid = 5001
  primarygroup = 5501
  passsha256 = "$DEV_SHA"

[[users]]
  name = "jose"
  givenname = "Jose"
  sn = "User"
  mail = "jose@empresa.com"
  uid = 5002
  primarygroup = 5502
  passsha256 = "$VIEW_SHA"

[[groups]]
  name = "svc"
  gid = 5500

[[groups]]
  name = "devs"
  gid = 5501

[[groups]]
  name = "plain"
  gid = 5502
EOF

export PGLITE_DIR="$TMP/pg" BUNDLES_DIR="$TMP/b" DATA_DIR="$TMP/d" PORT=3800 LOG_LEVEL=error
node apps/api/dist/index.js >"$TMP/api.log" 2>&1 &
API_PID=$!
cleanup() {
  kill "$API_PID" 2>/dev/null || true
  "$DOCKER" rm -f vch-ldap-smoke >/dev/null 2>&1 || true
  rm -rf "$TMP"
}
trap cleanup EXIT

"$DOCKER" rm -f vch-ldap-smoke >/dev/null 2>&1
"$DOCKER" run -d --name vch-ldap-smoke -p 3894:3894 \
  -v "$TMP/glauth.cfg:/etc/glauth/glauth.cfg:ro" -v "$TMP:/certs:ro" \
  docker.io/glauth/glauth:latest /app/glauth -c /etc/glauth/glauth.cfg >/dev/null 2>&1
if [ $? -ne 0 ]; then
  echo "FALLO: no se pudo levantar el directorio de pruebas (¿$DOCKER disponible?)"
  exit 1
fi
for _ in $(seq 1 40); do curl -sf "http://localhost:$PORT/healthz" >/dev/null 2>&1 && break; sleep 0.25; done

BASE="http://localhost:$PORT"
JAR_ADMIN="$TMP/a.txt"; JAR_MARIA="$TMP/m.txt"
PASS=0; FAIL=0
expect_eq() { if [ "$2" = "$3" ]; then PASS=$((PASS+1)); echo "  ok    $1"; else FAIL=$((FAIL+1)); echo "  FALLO $1 (obtuve: '$2', esperaba: '$3')"; fi }
py() { python3 -c "import json,sys; d=json.load(open(sys.argv[1])); print(eval(sys.argv[2]))" "$1" "$2"; }

curl -s -c "$JAR_ADMIN" -H 'Content-Type: application/json' \
  -d '{"email":"admin@empresa.com","password":"secreto123"}' "$BASE/api/auth/register" >/dev/null

LDAP_CFG='{"enabled":true,"mode":"ldaps","url":"localhost:3894","baseDn":"dc=empresa,dc=com","bindMode":"service","bindDn":"cn=svc-vch,dc=empresa,dc=com","bindPassword":"bindsecret","userFilter":"(uid={login})","mailAttr":"mail","groupAttr":"gidNumber","tlsSkipVerify":true,"roleMappings":[{"group":"5501","role":"developer"}],"defaultRole":"user"}'
curl -s -b "$JAR_ADMIN" -H 'Content-Type: application/json' -X PUT -d "$LDAP_CFG" "$BASE/api/ldap-config" >"$TMP/put.json"
expect_eq "config LDAP guardada y habilitada" "$(py "$TMP/put.json" "d['config']['enabled']")" "True"

echo "== test de conexión =="
curl -s -b "$JAR_ADMIN" -H 'Content-Type: application/json' -X POST -d '{}' "$BASE/api/ldap-config/test" >"$TMP/t1.json"
expect_eq "bind + búsqueda OK" "$(py "$TMP/t1.json" "d['ok']")" "True"
curl -s -b "$JAR_ADMIN" -H 'Content-Type: application/json' -X POST \
  -d '{"login":"maria","password":"devpass123"}' "$BASE/api/ldap-config/test" >"$TMP/t2.json"
expect_eq "autenticación de usuario OK" "$(py "$TMP/t2.json" "d['ok']")" "True"
expect_eq "rol detectado por grupo" "$(py "$TMP/t2.json" "d['role']")" "developer"
expect_eq "email resuelto del directorio" "$(py "$TMP/t2.json" "d['email']")" "maria@empresa.com"

echo "== JIT: primer login crea la cuenta =="
CODE=$(curl -s -o "$TMP/m.json" -w '%{http_code}' -c "$JAR_MARIA" -H 'Content-Type: application/json' \
  -d '{"email":"maria","password":"devpass123"}' "$BASE/api/auth/login")
expect_eq "login corporativo 200" "$CODE" "200"
expect_eq "rol mapeado" "$(py "$TMP/m.json" "d['user']['role']")" "developer"
expect_eq "auth_source=ldap" \
  "$(curl -s -b "$JAR_ADMIN" "$BASE/api/admin/users" | python3 -c "import json,sys; d=json.load(sys.stdin); u=[u for u in d['users'] if u['email']=='maria@empresa.com']; print(u[0]['auth_source'] if u else 'AUSENTE')")" "ldap"

echo "== guards =="
expect_eq "password errónea → 401" \
  "$(curl -s -o /dev/null -w '%{http_code}' -H 'Content-Type: application/json' -d '{"email":"maria","password":"mala"}' "$BASE/api/auth/login")" "401"
expect_eq "cambio de contraseña local → 403" \
  "$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR_MARIA" -H 'Content-Type: application/json' -d '{"currentPassword":"devpass123","newPassword":"otraclavesegura1"}' "$BASE/api/auth/change-password")" "403"
MARIA_ID=$(curl -s -b "$JAR_ADMIN" "$BASE/api/admin/users" | python3 -c "import json,sys; d=json.load(sys.stdin); u=[u for u in d['users'] if u['email']=='maria@empresa.com']; print(u[0]['id'] if u else '0')")
expect_eq "reset de admin → 400" \
  "$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR_ADMIN" -H 'Content-Type: application/json' -d '{"newPassword":"otraclavesegura1"}' "$BASE/api/admin/users/$MARIA_ID/reset-password")" "400"

echo "== directorio caído → 503 =="
"$DOCKER" stop vch-ldap-smoke >/dev/null
sleep 1
expect_eq "login sin directorio → 503" \
  "$(curl -s -o /dev/null -w '%{http_code}' -H 'Content-Type: application/json' -d '{"email":"maria","password":"devpass123"}' "$BASE/api/auth/login")" "503"

echo "== login local intacto =="
expect_eq "admin local OK" "$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR_ADMIN" "$BASE/api/auth/me")" "200"

echo
echo "== resultado: $PASS ok, $FAIL fallos =="
if [ "$FAIL" = "0" ]; then exit 0; else exit 1; fi
