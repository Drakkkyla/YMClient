#!/usr/bin/env bash
# Builds an UNSIGNED Hush.ipa on a Mac (CI) for sideloading with Sideloadly.
set -euo pipefail
cd "$(dirname "$0")/.."
export HOMEBREW_NO_AUTO_UPDATE=1

command -v xcodegen >/dev/null || brew install xcodegen
xcodebuild -version
xcodegen generate

rm -rf build Payload Hush.ipa
xcodebuild \
  -project Hush.xcodeproj -scheme Hush -configuration Release \
  -sdk iphoneos -destination 'generic/platform=iOS' -derivedDataPath build \
  CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO CODE_SIGN_IDENTITY="" \
  build

APP="build/Build/Products/Release-iphoneos/Hush.app"
[ -d "$APP" ] || { echo "Hush.app not found" >&2; ls -R build/Build/Products >&2 || true; exit 1; }
mkdir Payload
cp -R "$APP" Payload/
zip -qry Hush.ipa Payload
ls -lh Hush.ipa
