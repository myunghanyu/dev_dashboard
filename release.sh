#!/bin/sh
# Build Dev Dashboard.app and install it to /Applications. Usage: npm run release  (./release.sh build: build only)
set -e
cd "$(dirname "$0")"
APP="Dev Dashboard"

node collect.js > /dev/null # self-check; aborts release if broken

if [ ! -f icon.icns ] || [ icon.png -nt icon.icns ]; then
  rm -rf build.iconset && mkdir build.iconset
  for s in 16 32 128 256 512; do
    sips -z $s $s icon.png --out build.iconset/icon_${s}x${s}.png > /dev/null
    sips -z $((s*2)) $((s*2)) icon.png --out build.iconset/icon_${s}x${s}@2x.png > /dev/null
  done
  iconutil -c icns build.iconset -o icon.icns && rm -rf build.iconset
fi

npx electron-packager . "$APP" --platform=darwin --arch="$(uname -m)" --icon=icon.icns \
  --app-bundle-id=ai.avikus.dev-dashboard --out=dist --overwrite \
  --ignore='^/dist' --ignore='^/release\.sh' --ignore='\.svg$' --ignore='\.icns$'
codesign --force --deep -s - "dist/$APP-darwin-$(uname -m)/$APP.app" # ad-hoc sign, required on Apple Silicon
[ "$1" = build ] && exit 0 # CI: build only, no install

osascript -e "quit app \"$APP\"" 2>/dev/null || true
sleep 1
rm -rf "/Applications/$APP.app"
cp -R "dist/$APP-darwin-$(uname -m)/$APP.app" /Applications/
open "/Applications/$APP.app"
echo "Installed /Applications/$APP.app"
