#!/usr/bin/env bash
# Builds the native iPhone or Android project from scratch on the build machine.
# Usage: bash scripts/prepare-native.sh ios|android
#
# Needs these secret variables (set in Codemagic):
#   GOOGLE_SERVICE_INFO_PLIST  base64 of GoogleService-Info.plist (iPhone)
#   GOOGLE_SERVICES_JSON       base64 of google-services.json (Android)
set -euo pipefail

PLATFORM="${1:?say ios or android}"
cd "$(dirname "$0")/.."

npm install --no-audit --no-fund

# App icon and splash, made from the site's own icon.
mkdir -p resources
if [ ! -f resources/icon.png ]; then
  if command -v sips >/dev/null 2>&1; then
    sips -z 1024 1024 ../icon-512.png --out resources/icon.png >/dev/null
  else
    cp ../icon-512.png resources/icon.png
  fi
fi

if [ "$PLATFORM" = "ios" ]; then
  [ -d ios ] || npx cap add ios
  echo "$GOOGLE_SERVICE_INFO_PLIST" | base64 --decode > ios/App/App/GoogleService-Info.plist
  python3 scripts/patch-ios.py
  gem list -i xcodeproj >/dev/null 2>&1 || gem install xcodeproj --no-document
  ruby scripts/ios-project.rb
  npx capacitor-assets generate --ios \
    --iconBackgroundColor '#f7f2e9' --splashBackgroundColor '#f7f2e9'
  npx cap sync ios
elif [ "$PLATFORM" = "android" ]; then
  [ -d android ] || npx cap add android
  echo "$GOOGLE_SERVICES_JSON" | base64 --decode > android/app/google-services.json
  python3 scripts/patch-android.py
  npx capacitor-assets generate --android \
    --iconBackgroundColor '#f7f2e9' --splashBackgroundColor '#f7f2e9'
  npx cap sync android
else
  echo "Unknown platform: $PLATFORM" >&2
  exit 1
fi
