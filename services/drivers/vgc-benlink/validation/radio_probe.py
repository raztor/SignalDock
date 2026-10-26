"""Benlink discovery and read probe; does not program or transmit."""

import argparse
import asyncio
from datetime import datetime, timezone
from importlib.metadata import version
import json
import os
from pathlib import Path
import platform
import socket
import sys
import time

from bleak import BleakScanner
from benlink.command import CommandConnection
from benlink.link import RADIO_SERVICE_UUID
from validation_paths import RESULTS_DIRECTORY


def positive(value):
    number = float(value)
    if not 0 < number <= 300:
        raise argparse.ArgumentTypeError("Must be greater than 0 and at most 300 seconds.")
    return number


def parse_args():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    scan = commands.add_parser("scan", help="Discover nearby BLE devices")
    scan.add_argument("--seconds", type=positive, default=12)
    probe = commands.add_parser("probe", help="Read device information, status, and memories")
    probe.add_argument("address", help="BLE UUID on macOS; MAC address on Linux")
    probe.add_argument("--transport", choices=["ble", "rfcomm"], default="ble")
    probe.add_argument("--channel", type=int, help="Control RFCOMM channel verified through SDP")
    probe.add_argument("--timeout", type=positive, default=15)
    probe.add_argument("--channels", type=int, default=3, help="Maximum memories to read (0..256)")
    probe.add_argument("--watch", type=positive, help="Listen for events for this many seconds")
    parser.add_argument("--output", type=Path, help="JSON report path")
    args = parser.parse_args()
    if args.command == "probe":
        if not 0 <= args.channels <= 256:
            parser.error("--channels must be between 0 and 256")
        if args.transport == "rfcomm" and (args.channel is None or not 1 <= args.channel <= 30):
            parser.error("RFCOMM requires an SDP-verified --channel between 1 and 30")
    return args


class Report:
    def __init__(self, path):
        self.path = path
        self.data = {
            "started_utc": datetime.now(timezone.utc).isoformat(),
            "platform": platform.platform(),
            "python": platform.python_version(),
            "benlink": version("benlink"),
            "bleak": version("bleak"),
            "rfcomm_socket_available": all(hasattr(socket, name) for name in
                                           ("AF_BLUETOOTH", "BTPROTO_RFCOMM")),
            "result": "running",
            "steps": [],
        }

    def save(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        temporary = self.path.with_suffix(self.path.suffix + ".tmp")
        with temporary.open("w") as output:
            output.write(json.dumps(self.data, indent=2, ensure_ascii=False, default=repr) + "\n")
            output.flush()
            os.fsync(output.fileno())
        temporary.replace(self.path)

    async def step(self, name, awaitable, timeout):
        print(f"{name}...", flush=True)
        entry = {"name": name}
        self.data["steps"].append(entry)
        started = time.monotonic()
        try:
            result = await asyncio.wait_for(awaitable, timeout=timeout)
            entry["ok"] = True
            entry["value"] = result.model_dump(mode="json") if hasattr(result, "model_dump") else result
            print(json.dumps(entry["value"], ensure_ascii=False, default=repr), flush=True)
            return result
        except BaseException as error:
            entry.update(ok=False, error_type=type(error).__name__, error=str(error))
            raise
        finally:
            entry["seconds"] = round(time.monotonic() - started, 3)
            self.save()


async def scan(args, report):
    async def discover():
        found = await BleakScanner.discover(timeout=args.seconds, return_adv=True)
        return sorted([
            {
                "address": device.address,
                "name": adv.local_name or device.name,
                "rssi": adv.rssi,
                "services": adv.service_uuids,
                "advertises_benlink_service": RADIO_SERVICE_UUID in adv.service_uuids,
            }
            for device, adv in found.values()
        ], key=lambda item: (not item["advertises_benlink_service"], -item["rssi"]))

    devices = await report.step("ble_scan", discover(), args.seconds + 15)
    report.data["result"] = "scan_complete" if devices else "scan_empty"
    print("BLE discovery alone does not establish compatibility; device replies are still required.")
    return 0 if devices else 2


async def probe(args, report):
    report.data.update(address=args.address, transport=args.transport)
    if args.transport == "rfcomm" and not report.data["rfcomm_socket_available"]:
        raise RuntimeError("This Python has no RFCOMM sockets. Use BLE for control or the native Mac transport for local audio tests.")
    conn = (CommandConnection.new_ble(args.address) if args.transport == "ble"
            else CommandConnection.new_rfcomm(args.address, channel=args.channel))
    try:
        await report.step("connect", conn.connect(), args.timeout)
        info = await report.step("device_info", conn.get_device_info(), args.timeout)
        await report.step("status", conn.get_status(), args.timeout)
        await report.step("settings", conn.get_settings(), args.timeout)
        for index in range(min(args.channels, info.channel_count)):
            await report.step(f"channel_{index}", conn.get_channel(index), args.timeout)
        if args.watch:
            report.data["events"] = []

            def on_event(event):
                report.data["events"].append({"utc": datetime.now(timezone.utc).isoformat(),
                                              "event": repr(event)})
                print(repr(event), flush=True)
                report.save()

            remove = conn.add_event_handler(on_event)
            try:
                await report.step("subscribe_status", conn.enable_event("HT_STATUS_CHANGED"), args.timeout)
                print(f"Listening for events for {args.watch:g} seconds...", flush=True)
                await asyncio.sleep(args.watch)
            finally:
                remove()
        if not conn.is_connected():
            raise ConnectionError("The radio disconnected during the test.")
        report.data["result"] = "read_control_passed"
        report.data["not_tested"] = ["frequency_write", "audio_rx", "audio_tx", "ptt"]
        return 0
    finally:
        if conn.is_connected():
            await report.step("disconnect", conn.disconnect(), args.timeout)


def main():
    args = parse_args()
    filename = datetime.now().strftime("%Y%m%d-%H%M%S-%f") + f"-{args.command}.json"
    report = Report(args.output or RESULTS_DIRECTORY / filename)
    code = 1
    try:
        code = asyncio.run(scan(args, report) if args.command == "scan" else probe(args, report))
    except KeyboardInterrupt:
        report.data.update(result="interrupted")
        code = 130
    except Exception as error:
        report.data.update(result="failed", error_type=type(error).__name__, error=str(error))
        print(f"{type(error).__name__}: {error}", file=sys.stderr)
    finally:
        report.data["finished_utc"] = datetime.now(timezone.utc).isoformat()
        report.save()
        print(f"Report: {report.path.resolve()}", flush=True)
    return code


if __name__ == "__main__":
    sys.exit(main())
