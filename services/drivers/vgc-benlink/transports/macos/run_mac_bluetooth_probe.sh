#!/bin/bash
set -euo pipefail
task_script_dir="$(cd "$(dirname "$0")" && pwd)"
task_root="$(cd "$task_script_dir/../../../../.." && pwd)"
task_build_dir="$(mktemp -d /private/tmp/vrn7500-native.XXXXXX)"
trap 'rm -rf "$task_build_dir"' EXIT
task_app="$task_build_dir/RadioBluetoothProbe.app"
task_report="$task_root/results/$(date +%Y%m%d-%H%M%S)-classic.json"
mkdir -p "$task_app/Contents/MacOS" "$task_root/results"
cat > "$task_app/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>RadioBluetoothProbe</string>
<key>CFBundleIdentifier</key><string>cl.vgc.radiobluetoothprobe</string>
<key>CFBundleName</key><string>Radio Bluetooth Probe</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>LSUIElement</key><true/>
<key>NSBluetoothAlwaysUsageDescription</key><string>Connect the VR-N7500 for local control and RX/TX audio tests.</string>
</dict></plist>
PLIST
swiftc -swift-version 5 -module-cache-path /private/tmp/vr-n7500-swift-cache \
  "$task_script_dir/mac_bluetooth_probe.swift" -o "$task_app/Contents/MacOS/RadioBluetoothProbe"
# The documents folder may attach Finder attributes to new files.
# Clear them only from the generated bundle before local signing.
xattr -cr "$task_app"
codesign --force --sign - "$task_app"
printf 'Report: %s\n' "$task_report"
open -n -W "$task_app" --args "$task_report" "$@"
if [ ! -f "$task_report" ]; then exit 1; fi
"$task_root/.venv/bin/python" - "$task_report" <<'PY'
import json, sys
report = json.load(open(sys.argv[1]))
chunks = report.pop('audio_chunks_base64', [])
report['capture_chunk_count'] = len(chunks)
print(json.dumps(report, indent=2, ensure_ascii=False))
PY
