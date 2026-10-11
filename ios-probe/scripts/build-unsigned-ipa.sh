#!/usr/bin/env bash
# Builds an UNSIGNED arm64 YMProbe.ipa on a Mac (CI) for sideloading with Sideloadly/AltStore,
# which re-sign it with the user's own Apple ID. No certificates or Apple team needed.
#
#   1. tauri ios init      → generates the Xcode project (via XcodeGen) from project.yml
#   2. patch project.yml   → turn code signing off, regenerate the project
#   3. tauri ios build --archive-only → .xcarchive, skipping the CLI's signed export
#   4. add UIBackgroundModes=audio to the app's Info.plist (the skipped export is what would
#      normally merge extra plist keys) and zip Payload/YMProbe.app into an .ipa
set -euo pipefail
cd "$(dirname "$0")/.."

command -v xcodegen >/dev/null || brew install xcodegen

npx tauri ios init --ci

YML=src-tauri/gen/apple/project.yml
ruby -ryaml -e '
  f = ARGV[0]
  y = YAML.respond_to?(:unsafe_load_file) ? YAML.unsafe_load_file(f) : YAML.load_file(f)
  off = { "CODE_SIGNING_ALLOWED" => "NO", "CODE_SIGNING_REQUIRED" => "NO",
          "CODE_SIGN_IDENTITY" => "", "CODE_SIGN_STYLE" => "Manual", "DEVELOPMENT_TEAM" => "" }
  (y["targets"] || {}).each_value do |t|
    t["settings"] ||= {}
    t["settings"]["base"] ||= {}
    t["settings"]["base"].merge!(off)
  end
  File.write(f, y.to_yaml)
' "$YML"
(cd src-tauri/gen/apple && xcodegen generate --spec project.yml)

rm -rf src-tauri/gen/apple/build/*.xcarchive
npx tauri ios build --target aarch64 --archive-only --ci

# Tauri writes the archive to gen/apple/build/<name>_iOS.xcarchive. (Don't search folders that
# may not exist: under `set -e -o pipefail` a failing find inside $(...) silently kills the script.)
ARCHIVE=$(ls -dt src-tauri/gen/apple/build/*.xcarchive 2>/dev/null | head -1 || true)
[ -n "$ARCHIVE" ] || { echo "xcarchive not found in src-tauri/gen/apple/build" >&2; ls -la src-tauri/gen/apple/build >&2 || true; exit 1; }
APP=$(ls -d "$ARCHIVE"/Products/Applications/*.app 2>/dev/null | head -1 || true)
[ -n "$APP" ] || { echo ".app not found in $ARCHIVE" >&2; exit 1; }
echo "Archive: $ARCHIVE"
echo "App:     $APP"

PLIST="$APP/Info.plist"
/usr/libexec/PlistBuddy -c "Delete :UIBackgroundModes" "$PLIST" 2>/dev/null || true
/usr/libexec/PlistBuddy -c "Add :UIBackgroundModes array" -c "Add :UIBackgroundModes:0 string audio" "$PLIST"

rm -rf build-ipa YMProbe.ipa
mkdir -p build-ipa/Payload
cp -R "$APP" build-ipa/Payload/
(cd build-ipa && zip -qry ../YMProbe.ipa Payload)

file "$APP/$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$PLIST")"
/usr/libexec/PlistBuddy -c "Print :UIBackgroundModes" "$PLIST"
ls -lh YMProbe.ipa
