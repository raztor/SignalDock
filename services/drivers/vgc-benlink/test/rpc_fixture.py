"""Separate-process fake VGC service for Node/Python RPC conformance tests."""
import argparse
import asyncio
import json
from pathlib import Path
import signal

from fakes import FakeCodec, FakeControl, FakeTransport
from vgc_benlink.adapter import VgcDriver
from vgc_benlink.model import DriverConfig
from vgc_benlink.server import serve


async def run(args):
    config = DriverConfig(args.radio_id, "ble-fixture", "classic-fixture", working_memory=9,
        allow_experimental_tx=True, drain_seconds=0)
    control = FakeControl()
    # Every reconnect gets a fresh fake transport; no Bluetooth is imported/opened.
    driver = VgcDriver(config, control, lambda _: FakeTransport(control), FakeCodec)
    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for value in (signal.SIGINT, signal.SIGTERM): loop.add_signal_handler(value, stop.set)
    serving = asyncio.create_task(serve(driver, args.socket, args.token, stop))
    while not args.socket.exists():
        if serving.done(): await serving
        await asyncio.sleep(0.005)
    print(json.dumps({"ready": True, "endpoint": "unix:" + str(args.socket), "radioId": args.radio_id}), flush=True)
    await serving


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--socket", required=True, type=Path)
    parser.add_argument("--radio-id", default="00000000-0000-4000-8000-000000000004")
    parser.add_argument("--token", default="fixture-driver-token-with-at-least-32-characters")
    asyncio.run(run(parser.parse_args()))
