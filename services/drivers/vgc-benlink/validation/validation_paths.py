"""Stable repository paths for relocated VGC validation utilities."""
from pathlib import Path

REPOSITORY_ROOT = Path(__file__).resolve().parents[4]
RESULTS_DIRECTORY = REPOSITORY_ROOT / "results"
MACOS_PROBE = Path(__file__).resolve().parents[1] / "transports/macos/run_mac_bluetooth_probe.sh"
