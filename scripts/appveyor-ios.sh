#!/usr/bin/env bash
# AppVeyor (image macos-sonoma, Xcode 15.2) → unsigned YMClient.ipa via scripts/build-unsigned-ipa.sh.
set -eo pipefail
export HOMEBREW_NO_AUTO_UPDATE=1 HOMEBREW_NO_INSTALL_CLEANUP=1

# Node: the image ships nvm with older Nodes; Vite 6 wants a current one.
export NVM_DIR="$HOME/.nvm"
if [ -s "$NVM_DIR/nvm.sh" ]; then
  . "$NVM_DIR/nvm.sh"
  nvm install 22 >/dev/null
  nvm use 22
fi
set -u
node -v
npm -v
xcodebuild -version

# Rust with the iOS target.
if ! command -v rustup >/dev/null 2>&1; then
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal
fi
export PATH="$HOME/.cargo/bin:$PATH"
rustup target add aarch64-apple-ios

# Tauri's iOS tooling looks for CocoaPods; XcodeGen is installed by build-unsigned-ipa.sh.
command -v pod >/dev/null || brew install cocoapods

npm ci
bash scripts/build-unsigned-ipa.sh
