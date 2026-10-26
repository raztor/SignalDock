"""Launch the private Unix-socket service; startup does not connect to hardware."""
import argparse
import asyncio
import json
import os
from pathlib import Path
import signal
import stat

import grpc

from .adapter import VgcDriver
from .control import BenlinkControl
from .model import DriverConfig
from .service import VgcService, rpc


CONFIG_FIELDS = {
    "radioId": "radio_id", "bleAddress": "ble_address", "classicAddress": "classic_address",
    "audioChannel": "audio_channel", "workingMemoryId": "working_memory", "allowExperimentalTx": "allow_experimental_tx",
    "maxTxSeconds": "max_tx_seconds", "idleTxSeconds": "idle_tx_seconds", "audioOpenTimeout": "audio_open_timeout",
    "drainSeconds": "drain_seconds", "ffmpeg": "ffmpeg",
}


def load_config(path: Path) -> DriverConfig:
    raw = json.loads(path.read_text())
    if not isinstance(raw, dict) or set(raw) - set(CONFIG_FIELDS):
        raise ValueError("Driver config must be an object containing only declared manifest settings.")
    return DriverConfig(**{CONFIG_FIELDS[key]: value for key, value in raw.items()})


async def serve(driver: VgcDriver, socket_path: Path, token: str | None = None, stopping: asyncio.Event | None = None):
    if not socket_path.is_absolute():
        raise ValueError("An absolute private Unix-socket path is required.")
    if socket_path.exists():
        raise FileExistsError("Driver socket already exists; inspect the old process before removing a stale socket.")
    socket_path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    server = grpc.aio.server(options=[("grpc.max_receive_message_length", 1_048_576), ("grpc.max_send_message_length", 1_048_576)], maximum_concurrent_rpcs=64)
    rpc.add_RadioDriverServiceServicer_to_server(VgcService(driver, token), server)
    if not server.add_insecure_port("unix:" + str(socket_path)):
        raise RuntimeError("Driver socket could not be bound.")
    await server.start()
    os.chmod(socket_path, 0o600)
    inode = socket_path.stat().st_ino
    event = stopping or asyncio.Event()
    if stopping is None:
        loop = asyncio.get_running_loop()
        for value in (signal.SIGINT, signal.SIGTERM):
            loop.add_signal_handler(value, event.set)
    try:
        await event.wait()
    finally:
        await server.stop(3)
        await driver.disconnect()
        if socket_path.exists() and socket_path.stat().st_ino == inode:
            socket_path.unlink()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, required=True, help="Private driver configuration JSON")
    parser.add_argument("--socket", type=Path, help="Private absolute Unix socket path")
    parser.add_argument("--token-file", type=Path, help="Private bearer token file; never a command-line token")
    parser.add_argument("--check-config", action="store_true", help="Validate config offline without connecting or listening")
    parser.add_argument("--recover", action="store_true", help="Restore and verify the pending private snapshot; the driver service must be stopped")
    args = parser.parse_args()
    config = load_config(args.config)
    if args.check_config:
        print("VGC configuration is valid; no hardware connection was attempted.")
        return
    if args.socket is None:
        parser.error("--socket is required unless --check-config is used")
    control = BenlinkControl(config, recovery_directory=args.socket.parent / "recovery")
    if args.recover:
        if args.socket.exists():
            parser.error("Stop the driver and inspect its socket before recovery")
        asyncio.run(control.recover_pending())
        print("The pending snapshot was restored and verified.")
        return
    token = os.environ.get("SIGNALDOCK_DRIVER_TOKEN")
    if args.token_file:
        if stat.S_IMODE(args.token_file.stat().st_mode) & 0o077:
            parser.error("--token-file permissions must exclude group and other users")
        token = args.token_file.read_text().strip()
    if token is not None and (len(token) < 32 or not token.isascii()):
        parser.error("Driver bearer tokens must contain at least 32 ASCII characters")
    asyncio.run(serve(VgcDriver(config, control), args.socket, token))


if __name__ == "__main__":
    main()
