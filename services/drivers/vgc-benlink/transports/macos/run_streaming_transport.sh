#!/bin/bash
set -euo pipefail
if [ "$#" -ne 3 ]; then
  printf 'Usage: %s IPC_SOCKET CLASSIC_ADDRESS RFCOMM_CHANNEL\n' "$0" >&2
  exit 2
fi
module_dir="$(cd "$(dirname "$0")" && pwd)"
bundle_dir="$(mktemp -d /private/tmp/signaldock-vgc-stream.XXXXXX)"
trap 'rm -rf "$bundle_dir"' EXIT
bundle="$bundle_dir/SignalDockVgcTransport.app"
mkdir -p "$bundle/Contents/MacOS"
cat > "$bundle/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>SignalDockVgcTransport</string>
<key>CFBundleIdentifier</key><string>org.signaldock.vgc.transport</string>
<key>CFBundleName</key><string>SignalDock VGC Transport</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>LSUIElement</key><true/>
<key>NSBluetoothAlwaysUsageDescription</key><string>Connect the explicitly configured radio for SignalDock RX/TX audio.</string>
</dict></plist>
PLIST
swiftc -swift-version 5 -module-cache-path /private/tmp/signaldock-vgc-swift-cache \
  "$module_dir/streaming_transport.swift" -o "$bundle/Contents/MacOS/SignalDockVgcTransport"
xattr -cr "$bundle"
codesign --force --sign - "$bundle"
open -n -W "$bundle" --args "$1" "$2" "$3"
