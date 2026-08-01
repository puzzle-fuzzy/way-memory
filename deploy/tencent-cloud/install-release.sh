#!/usr/bin/env bash
set -Eeuo pipefail
IFS=$'\n\t'

DOMAIN="way-memory.yxswy.com"
EXPECTED_PUBLIC_IP="${WAY_MEMORY_EXPECTED_PUBLIC_IP:-101.35.246.159}"
RELEASE_DIR="${1:-}"
MODE="${2:-apply}"
WEB_ROOT="/var/www/way-memory"
API_ROOT="/opt/way-memory/api"
API_TARGET="$API_ROOT/way-memory-api.js"
SERVICE_TARGET="/etc/systemd/system/way-memory-api.service"
NGINX_TARGET="/etc/nginx/conf.d/way-memory.yxswy.com.conf"
ENV_FILE="/etc/way-memory/way-memory.env"
CERT_FILE="/etc/letsencrypt/live/$DOMAIN/fullchain.pem"
KEY_FILE="/etc/letsencrypt/live/$DOMAIN/privkey.pem"

fail() {
  echo "release install blocked: $*" >&2
  exit 1
}

[[ "$EUID" -eq 0 ]] || fail "run as root on the Tencent Cloud host"
[[ -n "$RELEASE_DIR" ]] || fail "usage: install-release.sh <release-directory> [--check-only]"
[[ "$MODE" == "apply" || "$MODE" == "--check-only" ]] || fail "second argument must be --check-only"
[[ -d "$RELEASE_DIR" ]] || fail "release directory does not exist"
RELEASE_DIR="$(cd -- "$RELEASE_DIR" && pwd -P)"
[[ "$RELEASE_DIR" != "/" && "$RELEASE_DIR" != "/opt" && "$RELEASE_DIR" != "/var" ]] || fail "refusing a broad release directory"

[[ -f "$RELEASE_DIR/RELEASE-MANIFEST.json" ]] || fail "RELEASE-MANIFEST.json is missing"
[[ -f "$RELEASE_DIR/api/way-memory-api.js" ]] || fail "bundled API is missing"
[[ -d "$RELEASE_DIR/web" ]] || fail "built web directory is missing"
[[ -f "$RELEASE_DIR/deploy/tencent-cloud/way-memory-api.production.service" ]] || fail "production systemd template is missing"
[[ -f "$RELEASE_DIR/deploy/tencent-cloud/way-memory.yxswy.com.nginx.conf.example" ]] || fail "production Nginx template is missing"

manifest_commit="$(grep -m1 '"sourceCommit"' "$RELEASE_DIR/RELEASE-MANIFEST.json" | sed -E 's/.*"sourceCommit"[[:space:]]*:[[:space:]]*"([0-9a-f]+)".*/\1/')"
[[ "$manifest_commit" =~ ^[0-9a-f]{7,64}$ ]] || fail "release manifest has no valid source commit"

[[ -f "$ENV_FILE" ]] || fail "$ENV_FILE is missing"
env_mode="$(stat -c '%a' "$ENV_FILE")"
env_owner="$(stat -c '%U:%G' "$ENV_FILE")"
[[ "$env_owner" == "root:root" ]] || fail "$ENV_FILE must be owned by root:root"
case "$env_mode" in
  400|440|600|640) ;;
  *) fail "$ENV_FILE permissions are too broad: $env_mode" ;;
esac

require_env_line() {
  local pattern="$1"
  grep -Eq "$pattern" "$ENV_FILE" || fail "required production environment setting is missing"
}

require_env_line '^WAY_MEMORY_AUTH_MODE=enforced$'
require_env_line '^WAY_MEMORY_PUBLIC_ORIGIN=https://way-memory\.yxswy\.com$'
require_env_line '^WAY_MEMORY_ALLOWED_ORIGIN=https://way-memory\.yxswy\.com$'
require_env_line '^WAY_MEMORY_RETENTION_DAYS=[1-9][0-9]{0,3}$'
require_env_line '^WAY_MEMORY_DB_PATH=/opt/way-memory/data/way-memory\.sqlite$'
require_env_line '^WAY_MEMORY_BOOTSTRAP_TOKEN=[^[:space:]]{32,}$'
retention_days="$(awk -F= '/^WAY_MEMORY_RETENTION_DAYS=/{print $2; exit}' "$ENV_FILE")"
(( retention_days >= 1 && retention_days <= 3650 )) || fail "retention days must be between 1 and 3650"

dns_ips="$(getent ahostsv4 "$DOMAIN" | awk '{print $1}' | sort -u || true)"
grep -Fxq "$EXPECTED_PUBLIC_IP" <<<"$dns_ips" || fail "$DOMAIN does not resolve to the expected public IP"

[[ -s "$CERT_FILE" ]] || fail "ACME certificate is missing"
[[ -s "$KEY_FILE" ]] || fail "ACME private key is missing"
openssl x509 -in "$CERT_FILE" -noout -checkend 259200 >/dev/null || fail "certificate expires within three days"
openssl x509 -in "$CERT_FILE" -noout -ext subjectAltName | grep -Fq "DNS:$DOMAIN" || fail "certificate does not cover $DOMAIN"
cert_key_digest="$(openssl x509 -in "$CERT_FILE" -pubkey -noout | openssl pkey -pubin -outform DER 2>/dev/null | sha256sum | awk '{print $1}')"
private_key_digest="$(openssl pkey -in "$KEY_FILE" -pubout 2>/dev/null | openssl pkey -pubin -outform DER 2>/dev/null | sha256sum | awk '{print $1}')"
[[ -n "$cert_key_digest" && "$cert_key_digest" == "$private_key_digest" ]] || fail "certificate and private key do not match"

command -v nginx >/dev/null 2>&1 || fail "nginx is not installed"
command -v curl >/dev/null 2>&1 || fail "curl is not installed"
id way-memory >/dev/null 2>&1 || fail "way-memory service account is missing"

if [[ "$MODE" == "--check-only" ]]; then
  echo "production release checks passed for source commit $manifest_commit"
  exit 0
fi

[[ "$WEB_ROOT" == "/var/www/way-memory" && "$API_TARGET" == "/opt/way-memory/api/way-memory-api.js" ]] || fail "deployment target invariant failed"
[[ ! -L "$WEB_ROOT" && ! -L "$API_ROOT" ]] || fail "refusing to replace a symlinked deployment directory"

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
backup_root="/var/backups/way-memory/$stamp-$manifest_commit"
web_stage="/var/www/.way-memory-web-$stamp"
api_stage="$API_ROOT/.way-memory-api-$stamp.new"
mkdir -p "$backup_root" "$API_ROOT" /var/www

restore_file() {
  local backup="$1"
  local target="$2"
  if [[ -f "$backup" ]]; then
    install -o root -g root -m 0644 "$backup" "$target"
  else
    rm -f -- "$target"
  fi
}

rollback() {
  set +e
  if [[ -d "$backup_root/web" ]]; then
    rm -rf -- "$WEB_ROOT"
    mv -- "$backup_root/web" "$WEB_ROOT"
  elif [[ -d "$WEB_ROOT" ]]; then
    rm -rf -- "$WEB_ROOT"
  fi
  restore_file "$backup_root/api/way-memory-api.js" "$API_TARGET"
  restore_file "$backup_root/systemd/way-memory-api.service" "$SERVICE_TARGET"
  restore_file "$backup_root/nginx/way-memory.yxswy.com.conf" "$NGINX_TARGET"
  systemctl daemon-reload
  systemctl restart way-memory-api.service
  nginx -t && systemctl reload nginx
  echo "rollback attempted; backup retained at $backup_root" >&2
}

failed=1
trap 'status=$?; if [[ $status -ne 0 && $failed -eq 1 ]]; then rollback; fi; exit $status' EXIT

if [[ -d "$WEB_ROOT" ]]; then
  mv -- "$WEB_ROOT" "$backup_root/web"
fi
mkdir -- "$web_stage"
cp -a "$RELEASE_DIR/web/." "$web_stage/"
chown -R root:root "$web_stage"
mv -- "$web_stage" "$WEB_ROOT"

if [[ -f "$API_TARGET" ]]; then
  mkdir -p "$backup_root/api"
  cp -a "$API_TARGET" "$backup_root/api/way-memory-api.js"
fi
install -o way-memory -g way-memory -m 0755 "$RELEASE_DIR/api/way-memory-api.js" "$api_stage"
mv -- "$api_stage" "$API_TARGET"

if [[ -f "$SERVICE_TARGET" ]]; then
  mkdir -p "$backup_root/systemd"
  cp -a "$SERVICE_TARGET" "$backup_root/systemd/way-memory-api.service"
fi
install -o root -g root -m 0644 "$RELEASE_DIR/deploy/tencent-cloud/way-memory-api.production.service" "$SERVICE_TARGET"

if [[ -f "$NGINX_TARGET" ]]; then
  mkdir -p "$backup_root/nginx"
  cp -a "$NGINX_TARGET" "$backup_root/nginx/way-memory.yxswy.com.conf"
fi
install -o root -g root -m 0644 "$RELEASE_DIR/deploy/tencent-cloud/way-memory.yxswy.com.nginx.conf.example" "$NGINX_TARGET"

nginx -t
systemctl daemon-reload
systemctl restart way-memory-api.service
for attempt in $(seq 1 30); do
  if curl --fail --silent --show-error --max-time 2 http://127.0.0.1:8787/health >/dev/null; then
    break
  fi
  [[ "$attempt" -lt 30 ]] || fail "local API health did not become ready"
  sleep 1
done
systemctl reload nginx

http_status="$(curl --silent --output /dev/null --write-out '%{http_code}' --max-time 10 "http://$DOMAIN/api/health")"
[[ "$http_status" == "301" || "$http_status" == "308" ]] || fail "HTTP endpoint did not redirect to HTTPS"
curl --fail --silent --show-error --max-time 10 "https://$DOMAIN/api/health" >/dev/null
curl --fail --silent --show-error --max-time 10 "https://$DOMAIN/" >/dev/null

failed=0
echo "production release installed for source commit $manifest_commit"
echo "backup: $backup_root"
