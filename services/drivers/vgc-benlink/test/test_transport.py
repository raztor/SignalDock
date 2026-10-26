"""Native build and launcher lifecycle checks; never open Bluetooth."""
import asyncio
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

from test_adapter import RADIO
from vgc_benlink.model import DriverConfig, DriverError
from vgc_benlink.transport import MacNativeTransport


class MacTransportTests(unittest.IsolatedAsyncioTestCase):
    async def test_failed_launcher_is_reported_before_the_open_deadline(self):
        with tempfile.TemporaryDirectory(prefix="sd-vgc-launch-test-") as directory:
            launcher = Path(directory) / "failed.sh"
            launcher.write_text("#!/bin/bash\nexit 7\n")
            config = DriverConfig(RADIO, "fixture-ble", "fixture-classic")
            transport = MacNativeTransport(config, launcher)
            with patch("vgc_benlink.transport.sys.platform", "darwin"):
                with self.assertRaises(DriverError) as failed:
                    await asyncio.wait_for(transport.open(), 1)
            self.assertIn("exit 7", str(failed.exception))
            self.assertIsNone(transport.process)
            self.assertIsNone(transport.server)
            self.assertIsNone(transport.directory)

    @unittest.skipUnless(sys.platform == "darwin" and shutil.which("swiftc"), "Mac Swift compiler is required")
    async def test_native_helper_builds_without_launching(self):
        source = Path(__file__).resolve().parents[1] / "transports/macos/streaming_transport.swift"
        with tempfile.TemporaryDirectory(prefix="sd-vgc-build-test-", dir="/private/tmp") as directory:
            result = await asyncio.to_thread(subprocess.run,
                ["swiftc", "-swift-version", "5", "-module-cache-path", "/private/tmp/signaldock-vgc-swift-cache",
                 str(source), "-o", str(Path(directory) / "SignalDockVgcTransport")],
                capture_output=True, text=True, timeout=30)
            self.assertEqual(result.returncode, 0, result.stderr)
