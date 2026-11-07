#!/usr/bin/env bash
#
# Build the owner and/or customer Android app.
#
#   ./scripts/build-apps.sh                         # debug + release, both apps
#   ./scripts/build-apps.sh --release --aab         # release APK + Play bundle
#   ./scripts/build-apps.sh --debug --client-only
#   ./scripts/build-apps.sh --release \
#       --api-url https://api.example.com/ \
#       --version-code 11 --version-name 3.2.0
#
# Signing credentials are read from the environment. If they are not set, the
# script sources (in order):
#   .tooling/keystore.env          -> owner key
#   .tooling/client-keystore.env   -> customer key
# Both files are gitignored.
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DIST="$ROOT/../../dist/android"

VARIANT="both"
AAB=0
CLEAN=0
OWNER=1
CLIENT=1
ALLOW_PLACEHOLDER=0
API_URL="${DXN_API_URL:-}"
VERSION_CODE=""
VERSION_NAME=""

usage() {
  sed -n '2,18p' "$0" | sed 's/^# \{0,1\}//'
  exit 0
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --debug) VARIANT="debug" ;;
    --release) VARIANT="release" ;;
    --both) VARIANT="both" ;;
    --aab) AAB=1 ;;
    --clean) CLEAN=1 ;;
    --owner-only) OWNER=1; CLIENT=0 ;;
    --client-only) OWNER=0; CLIENT=1 ;;
    --api-url) API_URL="${2:?--api-url needs a value}"; shift ;;
    --allow-placeholder) ALLOW_PLACEHOLDER=1 ;;
    --version-code) VERSION_CODE="${2:?--version-code needs a value}"; shift ;;
    --version-name) VERSION_NAME="${2:?--version-name needs a value}"; shift ;;
    -h|--help) usage ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

# Windows paths in these files are unquoted (C:\Users\...), so `source` would
# eat the backslashes. Parse KEY=VALUE literally instead.
load_env() {
  local file="$1" line key value
  [[ -f "$file" ]] || return 0
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%$'\r'}"
    line="${line#export }"
    [[ -z "$line" || "$line" == \#* || "$line" != *=* ]] && continue
    key="${line%%=*}"
    value="${line#*=}"
    [[ "$key" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || continue
    if [[ "$value" == \"*\" || "$value" == \'*\' ]]; then
      value="${value:1:${#value}-2}"
    fi
    export "$key=$value"
  done < "$file"
}

for env_file in "$ROOT/../../.tooling/keystore.env" "$ROOT/.tooling/keystore.env"; do
  load_env "$env_file"
done
for env_file in "$ROOT/../../.tooling/client-keystore.env" "$ROOT/.tooling/client-keystore.env"; do
  load_env "$env_file"
done

# Fail loudly instead of silently shipping an unsigned APK. If the configured
# keystore rejects the stored password, fall back to the original key backup.
if [[ -n "${DXN_KEYSTORE:-}" && -n "${DXN_KEYSTORE_PASSWORD:-}" && -f "${DXN_KEYSTORE:-}" ]]; then
  if ! keytool -list -keystore "$DXN_KEYSTORE" -storepass:env DXN_KEYSTORE_PASSWORD \
      -alias "${DXN_KEY_ALIAS:-dxn}" >/dev/null 2>&1; then
    if [[ -f "$DXN_KEYSTORE.bak" ]] && keytool -list -keystore "$DXN_KEYSTORE.bak" \
        -storepass:env DXN_KEYSTORE_PASSWORD -alias "${DXN_KEY_ALIAS:-dxn}" >/dev/null 2>&1; then
      echo "WARNING: password does not match $DXN_KEYSTORE; using $DXN_KEYSTORE.bak" >&2
      export DXN_KEYSTORE="$DXN_KEYSTORE.bak"
    else
      echo "WARNING: owner keystore could not be unlocked; owner release will be unsigned." >&2
      echo "         Fix DXN_KEYSTORE_PASSWORD in .tooling/keystore.env." >&2
    fi
  fi
fi

if [[ -z "$API_URL" ]]; then
  API_URL="$(grep '^dxn.apiBaseUrl=' "$ROOT/gradle.properties" | cut -d= -f2-)"
fi
if [[ "$VARIANT" != "debug" && ( -z "$API_URL" || "$API_URL" == *"shop.example.com"* ) ]]; then
  if [[ $ALLOW_PLACEHOLDER -ne 1 ]]; then
    echo "ERROR: set the production API with --api-url https://your-domain/ (or DXN_API_URL)." >&2
    echo "       Refusing to build a release that points at the placeholder domain." >&2
    echo "       Pass --allow-placeholder only for a throw-away verification build." >&2
    exit 2
  fi
  echo "WARNING: building a release against the placeholder API $API_URL" >&2
fi

GRADLE_ARGS=(--console=plain)
if [[ $CLEAN -eq 1 ]]; then GRADLE_ARGS+=(clean); fi
if [[ -n "$API_URL" ]]; then GRADLE_ARGS+=("-Pdxn.apiBaseUrl=$API_URL"); fi
if [[ -n "$VERSION_CODE" ]]; then GRADLE_ARGS+=("-Pdxn.versionCode=$VERSION_CODE"); fi
if [[ -n "$VERSION_NAME" ]]; then GRADLE_ARGS+=("-Pdxn.versionName=$VERSION_NAME"); fi

TASKS=()
if [[ "$VARIANT" == "debug" || "$VARIANT" == "both" ]]; then
  [[ $OWNER -eq 1 ]] && TASKS+=(":owner-app:assembleDebug")
  [[ $CLIENT -eq 1 ]] && TASKS+=(":client-app:assembleDebug")
fi
if [[ "$VARIANT" == "release" || "$VARIANT" == "both" ]]; then
  [[ $OWNER -eq 1 ]] && TASKS+=(":owner-app:assembleRelease")
  [[ $CLIENT -eq 1 ]] && TASKS+=(":client-app:assembleRelease")
  if [[ $AAB -eq 1 ]]; then
    [[ $OWNER -eq 1 ]] && TASKS+=(":owner-app:bundleRelease")
    [[ $CLIENT -eq 1 ]] && TASKS+=(":client-app:bundleRelease")
  fi
fi

echo "==> Building: ${TASKS[*]}"
cd "$ROOT"

# Windows antivirus / indexing can corrupt Gradle's ZipBuilder temp files in
# %TEMP% (Manifest merger: "The file or directory is corrupted"). Give the
# build its own temp dir inside the project so AAB packaging is reliable.
if [[ $AAB -eq 1 || "$VARIANT" != "debug" ]]; then
  JAVA_TMP="$ROOT/build/tmp-java"
  mkdir -p "$JAVA_TMP"
  if command -v cygpath >/dev/null 2>&1; then
    # GRADLE_OPTS is word-split by the wrapper, so use the 8.3 path when the
    # project lives under a directory with spaces (e.g. "0 DXN").
    JAVA_TMP="$(cygpath -d "$JAVA_TMP" 2>/dev/null || cygpath -m "$JAVA_TMP")"
    JAVA_TMP="${JAVA_TMP//\\//}"
  fi
  export GRADLE_OPTS="${GRADLE_OPTS:+$GRADLE_OPTS }-Djava.io.tmpdir=$JAVA_TMP"
fi

./gradlew "${TASKS[@]}" "${GRADLE_ARGS[@]}"

VERSION_NAME="${VERSION_NAME:-$(grep '^dxn.versionName=' "$ROOT/gradle.properties" | cut -d= -f2)}"
VERSION_CODE="${VERSION_CODE:-$(grep '^dxn.versionCode=' "$ROOT/gradle.properties" | cut -d= -f2)}"
mkdir -p "$DIST"

copy_artifacts() {
  local app="$1" label="$2"
  if [[ "$VARIANT" == "debug" || "$VARIANT" == "both" ]]; then
    local src="$ROOT/$app/build/outputs/apk/debug/$app-debug.apk"
    [[ -f "$src" ]] && cp "$src" "$DIST/dxn-$label-$VERSION_NAME-$VERSION_CODE-debug.apk"
  fi
  if [[ "$VARIANT" == "release" || "$VARIANT" == "both" ]]; then
    local src="$ROOT/$app/build/outputs/apk/release/$app-release.apk"
    if [[ -f "$src" ]]; then
      cp "$src" "$DIST/dxn-$label-$VERSION_NAME-$VERSION_CODE.apk"
      if [[ -f "$src" ]] && command -v apksigner >/dev/null 2>&1; then
        if ! apksigner verify --print-certs "$src" >/dev/null 2>&1; then
          echo "WARNING: $app release APK is unsigned. Set the signing env vars." >&2
        fi
      fi
    fi
    if [[ $AAB -eq 1 ]]; then
      local bundle="$ROOT/$app/build/outputs/bundle/release/$app-release.aab"
      [[ -f "$bundle" ]] && cp "$bundle" "$DIST/dxn-$label-$VERSION_NAME-$VERSION_CODE.aab"
    fi
  fi
}

[[ $OWNER -eq 1 ]] && copy_artifacts "owner-app" "owner"
[[ $CLIENT -eq 1 ]] && copy_artifacts "client-app" "client"

echo
echo "==> Artifacts in $DIST"
ls -lh "$DIST"
echo
if command -v sha256sum >/dev/null 2>&1; then
  sha256sum "$DIST"/* 2>/dev/null || true
fi
