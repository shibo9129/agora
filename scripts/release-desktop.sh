#!/usr/bin/env bash
# Agora desktop release (macOS, GitHub distribution):
#   preflight → sidecar → tauri build (Developer ID sign + notarize) →
#   staple/verify → update.json (minisign) → GitHub release upload.
#
# One-time setup: docs/release-desktop.md
# Credentials:    scripts/.release.env (gitignored; see scripts/release.env.example)
#
# Usage: scripts/release-desktop.sh 0.1.4 ["release notes"]
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="/usr/bin:/bin:$HOME/.cargo/bin:$PATH"  # /usr/bin 优先：~/.local/bin/xattr（Python 版）不支持 -r，会让 tauri 打包失败

VERSION="${1:?usage: scripts/release-desktop.sh <version> [\"notes\"]  e.g. 0.1.4}"
NOTES="${2:-macOS 桌面版 $VERSION}"
ENV_FILE="scripts/.release.env"
[[ -f "$ENV_FILE" ]] || { echo "✗ missing $ENV_FILE — copy scripts/release.env.example and fill it in"; exit 1; }
set -a; source "$ENV_FILE"; set +a
# 凭证文件里手写的 ~ 不会被 shell 展开，这里兜底
TAURI_SIGNING_PRIVATE_KEY="${TAURI_SIGNING_PRIVATE_KEY/#\~/$HOME}"

echo "── preflight ──────────────────────────────────────────"
TAURI_VER=$(node -p "JSON.parse(require('fs').readFileSync('apps/desktop/src-tauri/tauri.conf.json','utf8')).version")
PKG_VER=$(node -p "require('./apps/server/package.json').version")
[[ "$TAURI_VER" == "$VERSION" && "$PKG_VER" == "$VERSION" ]] \
  || { echo "✗ version mismatch: arg=$VERSION tauri.conf.json=$TAURI_VER apps/server/package.json=$PKG_VER"; exit 1; }
security find-identity -v -p codesigning | grep -q "Developer ID Application" \
  || { echo "✗ no 'Developer ID Application' identity in keychain — see docs/release-desktop.md §1"; exit 1; }
: "${APPLE_SIGNING_IDENTITY:?set in $ENV_FILE}"
: "${APPLE_ID:?set in $ENV_FILE}" "${APPLE_PASSWORD:?set in $ENV_FILE}" "${APPLE_TEAM_ID:?set in $ENV_FILE}"
: "${TAURI_SIGNING_PRIVATE_KEY:?updater minisign key — set in $ENV_FILE}"
gh auth status >/dev/null 2>&1 || { echo "✗ gh not authenticated"; exit 1; }
echo "✓ version $VERSION, signing identity: $APPLE_SIGNING_IDENTITY"

# create-dmg 会被历史遗留挂载（/Volumes/Agora*、/Volumes/dmg.*）卡出 Resource busy
for v in /Volumes/Agora* /Volumes/dmg.*; do
  [ -e "$v" ] && hdiutil detach -quiet -force "$v" 2>/dev/null || true
done

echo "── build (sign + notarize happen inside tauri build) ──"
node scripts/prepare-sidecar.mjs

# Notarization requires EVERY Mach-O in the bundle to be Developer-ID signed
# with hardened runtime + secure timestamp. tauri-bundler signs executables
# (main binary + sidecars, with bundle.macOS.entitlements → JIT for V8) but
# NOT .node resources, so pre-sign those here (inside-out).
SIDECAR="apps/desktop/src-tauri/sidecar"
find "$SIDECAR" -type f \( -name "*.node" -o -name "*.dylib" \) -print0 |
while IFS= read -r -d '' f; do
  codesign --sign "$APPLE_SIGNING_IDENTITY" --options runtime --timestamp --force "$f"
  echo "  signed $f"
done

# 只打 app：tauri 的 create-dmg 走 hdiutil create（本机 diskimagesiod 卡死会 Resource busy），
# dmg 改由下方 diskutil image create from 手工构建（Apple 官方替代路径）。
( cd apps/desktop && cargo tauri build --config '{"bundle":{"targets":["app"]}}' )

BUNDLE="apps/desktop/src-tauri/target/release/bundle"
APP="$BUNDLE/macos/Agora.app"
DMG="$BUNDLE/dmg/Agora_${VERSION}_aarch64.dmg"
TARBALL="$BUNDLE/macos/Agora.app.tar.gz"
SIG="$TARBALL.sig"
[[ -d "$APP" && -f "$TARBALL" && -f "$SIG" ]] || { echo "✗ missing build artifacts under $BUNDLE"; exit 1; }

echo "── verify signature + notarization ────────────────────"
codesign --verify --deep --strict "$APP" && echo "✓ codesign valid"
spctl -a -vv "$APP"
xcrun stapler validate "$APP" && echo "✓ app ticket stapled"

# The signed sidecar must actually RUN under hardened runtime (0.1.4 first
# attempt: node-runtime SIGTRAP'd without JIT entitlements).
RESP=$( { echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"release-check","version":"1"}}}'; sleep 4; } | AGORA_HOME="$HOME/.agora" "$APP/Contents/MacOS/node-runtime" "$APP/Contents/Resources/sidecar/dist/mcp-stdio.mjs" 2>&1 || true )
echo "$RESP" | grep -q '"serverInfo"' \
  && echo "✓ sidecar MCP initialize ok under hardened runtime" \
  || { echo "✗ sidecar failed to run after signing: $RESP"; exit 1; }

echo "── build dmg (diskutil) ───────────────────────────────"
mkdir -p "$BUNDLE/dmg"
STAGE_PARENT=$(mktemp -d)
STAGE="$STAGE_PARENT/agora"
mkdir -p "$STAGE"
cp -R "$APP" "$STAGE/Agora.app"
ln -s /Applications "$STAGE/Applications"
rm -f "$DMG"
diskutil image create from --volumeName "Agora" --format UDZO "$STAGE" "$DMG"
rm -rf "$STAGE_PARENT"
codesign --sign "$APPLE_SIGNING_IDENTITY" --timestamp --force "$DMG"
echo "✓ dmg built & signed"

# Gatekeeper evaluates the dmg itself on download; notarize+staple it too when
# the bundler didn't already.
if xcrun stapler validate "$DMG" >/dev/null 2>&1; then
  echo "✓ dmg ticket stapled"
else
  echo "… dmg has no ticket — notarizing dmg explicitly"
  xcrun notarytool submit "$DMG" --apple-id "$APPLE_ID" --password "$APPLE_PASSWORD" --team-id "$APPLE_TEAM_ID" --wait
  xcrun stapler staple "$DMG"
  xcrun stapler validate "$DMG"
fi

echo "── updater manifest ───────────────────────────────────"
PUB_DATE=$(date -u +%Y-%m-%dT%H:%M:%SZ)
SIGNATURE=$(tr -d '\n' < "$SIG")
cat > "$BUNDLE/update.json" <<JSON
{
  "version": "$VERSION",
  "pub_date": "$PUB_DATE",
  "url": "https://github.com/stanshek/agora/releases/download/v$VERSION/Agora.app.tar.gz",
  "signature": "$SIGNATURE",
  "notes": "$NOTES"
}
JSON
echo "✓ update.json"

echo "── publish to GitHub ──────────────────────────────────"
if gh release view "v$VERSION" >/dev/null 2>&1; then
  gh release upload "v$VERSION" "$DMG" "$TARBALL" "$SIG" "$BUNDLE/update.json" --clobber
else
  gh release create "v$VERSION" --title "Agora v$VERSION — $NOTES" --notes "$NOTES" \
    "$DMG" "$TARBALL" "$SIG" "$BUNDLE/update.json"
fi
echo "✅ released v$VERSION — https://github.com/stanshek/agora/releases/tag/v$VERSION"
