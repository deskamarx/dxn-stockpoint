#!/usr/bin/env bash
#
# Bump the shared version for both apps.
#
#   ./scripts/bump-version.sh             # patch +1, versionCode +1
#   ./scripts/bump-version.sh 3.2.0       # explicit versionName, versionCode +1
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
FILE="$ROOT/gradle.properties"

[[ -f "$FILE" ]] || { echo "Missing $FILE" >&2; exit 1; }

CODE="$(grep '^dxn.versionCode=' "$FILE" | cut -d= -f2)"
NAME="$(grep '^dxn.versionName=' "$FILE" | cut -d= -f2)"

NEW_CODE=$((CODE + 1))
if [[ $# -gt 0 ]]; then
  NEW_NAME="$1"
else
  IFS=. read -r MAJOR MINOR PATCH <<< "$NAME"
  PATCH="${PATCH:-0}"
  NEW_NAME="$MAJOR.$MINOR.$((PATCH + 1))"
fi

sed -i.bak "s/^dxn.versionCode=.*/dxn.versionCode=$NEW_CODE/" "$FILE"
sed -i.bak "s/^dxn.versionName=.*/dxn.versionName=$NEW_NAME/" "$FILE"
rm -f "$FILE.bak"

echo "Version: $NAME ($CODE) -> $NEW_NAME ($NEW_CODE)"
