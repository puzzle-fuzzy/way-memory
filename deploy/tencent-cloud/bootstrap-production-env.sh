#!/usr/bin/env bash
set -Eeuo pipefail
IFS=$'\n\t'
umask 077

DOMAIN="way-memory.yxswy.com"
EXPECTED_PUBLIC_IP="${WAY_MEMORY_EXPECTED_PUBLIC_IP:-101.35.246.159}"
ENV_DIR="/etc/way-memory"
ENV_FILE="$ENV_DIR/way-memory.env"
TOKEN_FILE="$ENV_DIR/bootstrap-token"

fail() {
  echo "production environment bootstrap blocked: $*" >&2
  exit 1
}

[[ "$EUID" -eq 0 ]] || fail "run as root on the Tencent Cloud host"
[[ "$#" -eq 0 ]] || fail "this command takes no arguments"
command -v getent >/dev/null 2>&1 || fail "getent is not installed"
command -v openssl >/dev/null 2>&1 || fail "openssl is not installed"
command -v install >/dev/null 2>&1 || fail "install is not available"

[[ ! -e "$ENV_FILE" ]] || fail "$ENV_FILE already exists; refusing to overwrite it"
[[ ! -e "$TOKEN_FILE" ]] || fail "$TOKEN_FILE already exists; refusing to overwrite it"

dns_ips="$(getent ahostsv4 "$DOMAIN" | awk '{print $1}' | sort -u || true)"
grep -Fxq "$EXPECTED_PUBLIC_IP" <<<"$dns_ips" || fail "$DOMAIN does not resolve to the expected public IP $EXPECTED_PUBLIC_IP"

install -d -o root -g root -m 0700 "$ENV_DIR"
env_tmp="$(mktemp "$ENV_DIR/.way-memory.env.XXXXXX")"
token_tmp="$(mktemp "$ENV_DIR/.bootstrap-token.XXXXXX")"
created_env=0
created_token=0

cleanup() {
  if [[ "$created_token" -eq 1 ]]; then rm -f -- "$TOKEN_FILE"; fi
  if [[ "$created_env" -eq 1 ]]; then rm -f -- "$ENV_FILE"; fi
  rm -f -- "$env_tmp" "$token_tmp"
}
trap cleanup EXIT

bootstrap_token="$(openssl rand -hex 32)"
[[ "$bootstrap_token" =~ ^[0-9a-f]{64}$ ]] || fail "openssl returned an invalid bootstrap token"

cat > "$env_tmp" <<EOF
WAY_MEMORY_AUTH_MODE=enforced
WAY_MEMORY_PUBLIC_ORIGIN=https://$DOMAIN
WAY_MEMORY_ALLOWED_ORIGIN=https://$DOMAIN
WAY_MEMORY_RETENTION_DAYS=90
WAY_MEMORY_DB_PATH=/opt/way-memory/data/way-memory.sqlite
WAY_MEMORY_BOOTSTRAP_TOKEN=$bootstrap_token
EOF
printf '%s\n' "$bootstrap_token" > "$token_tmp"
chown root:root "$env_tmp" "$token_tmp"
chmod 0600 "$env_tmp" "$token_tmp"

# Hard-linking the prepared files creates each destination without allowing a
# concurrent invocation to replace an existing secret file.
ln -- "$env_tmp" "$ENV_FILE" || fail "$ENV_FILE was created concurrently"
created_env=1
ln -- "$token_tmp" "$TOKEN_FILE" || fail "$TOKEN_FILE was created concurrently"
created_token=1
rm -f -- "$env_tmp" "$token_tmp"
trap - EXIT

echo "Production environment initialized for $DOMAIN."
echo "Environment file: $ENV_FILE (root:root, mode 600)"
echo "Bootstrap token file: $TOKEN_FILE (root:root, mode 600; token content was not printed)"
echo "Run the release installer in --check-only mode after the ACME certificate is ready."
