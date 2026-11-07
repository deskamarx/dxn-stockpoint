#!/usr/bin/env bash
#
# Generate the suite app signing key. This is separate from the owner and
# customer keys on purpose: each app has its own signing identity.
#
#   ./scripts/new-suite-keystore.sh
#   ./scripts/new-suite-keystore.sh --alias my-alias
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
KEYSTORE="$ROOT/suite-release.keystore"
ENV_FILE="$ROOT/.tooling/suite-keystore.env"
ALIAS="dxn-suite"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --alias) ALIAS="${2:?--alias needs a value}"; shift ;;
    -h|--help) sed -n '2,8p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

command -v keytool >/dev/null 2>&1 || {
  echo "keytool was not found. Install a JDK 17+ or run this inside Android Studio." >&2
  exit 1
}

if [[ -e "$KEYSTORE" ]]; then
  echo "Refusing to overwrite $KEYSTORE." >&2
  echo "Back it up first, or delete it deliberately if you really mean to rotate the key." >&2
  exit 1
fi

if command -v openssl >/dev/null 2>&1; then
  PASSWORD="$(openssl rand -base64 36 | tr -dc 'A-Za-z0-9' | head -c 32)"
else
  PASSWORD="$(head -c 48 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 32)"
fi

mkdir -p "$ROOT/.tooling"

keytool -genkeypair \
  -keystore "$KEYSTORE" \
  -alias "$ALIAS" \
  -keyalg RSA \
  -keysize 4096 \
  -validity 10000 \
  -storepass "$PASSWORD" \
  -keypass "$PASSWORD" \
  -dname "CN=DXN Stockpoint Suite, O=DXN Stockpoint, L=Dhaka, C=BD"

cat > "$ENV_FILE" <<EOF
# Suite app signing credentials — generated $(date -u +%Y-%m-%dT%H:%M:%SZ)
# Keep this file and $KEYSTORE private. Both are gitignored.
export DXN_SUITE_KEYSTORE="$KEYSTORE"
export DXN_SUITE_KEYSTORE_PASSWORD="$PASSWORD"
export DXN_SUITE_KEY_ALIAS="$ALIAS"
export DXN_SUITE_KEY_PASSWORD="$PASSWORD"
EOF

chmod 600 "$KEYSTORE" "$ENV_FILE" 2>/dev/null || true

echo "Created $KEYSTORE"
echo "Wrote   $ENV_FILE"
echo
echo "Back up BOTH files somewhere safe. Losing them means the suite app can"
echo "never be updated without a new package id."
