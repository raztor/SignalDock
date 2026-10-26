"""Bounded continuous Bluetooth audio transports; no radio discovery by name."""
import asyncio
import base64
import json
import os
from pathlib import Path
import socket
import sys
import tempfile
from typing import AsyncIterator, Protocol

from .model import DriverConfig, DriverError


class AudioTransport(Protocol):
    async def open(self) -> None: ...
    def receive(self) -> AsyncIterator[bytes]: ...
    async def write(self, data: bytes) -> None: ...
    async def arm(self, tx_id: str, ttl_seconds: float) -> None: ...
    async def disarm(self) -> None: ...
    async def close(self) -> None: ...


class LinuxRfcommTransport:
    def __init__(self, config: DriverConfig):
        self.config = config
        self.socket = None

    async def open(self):
        if sys.platform != "linux" or not hasattr(socket, "AF_BLUETOOTH"):
            raise DriverError("CAPABILITY_UNSUPPORTED", "Linux Bluetooth RFCOMM is not available.")
        self.socket = socket.socket(socket.AF_BLUETOOTH, socket.SOCK_STREAM, socket.BTPROTO_RFCOMM)
        self.socket.setblocking(False)
        try:
            await asyncio.get_running_loop().sock_connect(self.socket, (self.config.classic_address, self.config.audio_channel))
        except BaseException:
            await self.close()
            raise

    async def receive(self):
        while self.socket is not None:
            data = await asyncio.get_running_loop().sock_recv(self.socket, 4096)
            if not data:
                raise DriverError("RADIO_UNAVAILABLE", "The radio closed its audio link.")
            yield data

    async def write(self, data):
        if self.socket is None:
            raise DriverError("RADIO_UNAVAILABLE", "The audio link is closed.")
        await asyncio.get_running_loop().sock_sendall(self.socket, data)

    async def arm(self, tx_id, ttl_seconds):
        # Local grant supervision runs in the Python driver process.
        pass

    async def disarm(self):
        pass

    async def close(self):
        if self.socket is not None:
            self.socket.close()
            self.socket = None


class MacNativeTransport:
    """Long-lived native helper with independent grant/parent-loss supervision."""
    def __init__(self, config: DriverConfig, launcher: Path | None = None):
        self.config = config
        module = Path(__file__).resolve().parents[2]
        self.launcher = launcher or module / "transports/macos/run_streaming_transport.sh"
        self.writer = None
        self.reader = None
        self.process = None
        self.server = None
        self.directory = None
        self._write_lock = asyncio.Lock()

    async def open(self):
        if sys.platform != "darwin":
            raise DriverError("CAPABILITY_UNSUPPORTED", "The native Mac transport requires macOS.")
        self.directory = tempfile.TemporaryDirectory(prefix="sd-vgc-")
        path = Path(self.directory.name) / "transport.sock"
        connected = asyncio.get_running_loop().create_future()

        def accepted(reader, writer):
            if connected.done():
                writer.close()
            else:
                connected.set_result((reader, writer))

        self.server = await asyncio.start_unix_server(accepted, path=str(path), limit=16384)
        os.chmod(path, 0o600)
        exited = None
        try:
            self.process = await asyncio.create_subprocess_exec("bash", str(self.launcher), str(path), self.config.classic_address,
                str(self.config.audio_channel), stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL)
            exited = asyncio.create_task(self.process.wait())
            done, _ = await asyncio.wait((connected, exited), timeout=self.config.audio_open_timeout + 15,
                return_when=asyncio.FIRST_COMPLETED)
            if connected not in done:
                if exited in done:
                    raise DriverError("RADIO_UNAVAILABLE", "The native launcher exited before opening its private IPC connection (exit " + str(exited.result()) + ").")
                raise DriverError("DEADLINE_EXCEEDED", "The native launcher did not connect before its opening deadline.")
            self.reader, self.writer = connected.result()
            message = json.loads(await asyncio.wait_for(self.reader.readline(), self.config.audio_open_timeout))
            if message.get("type") != "ready":
                raise DriverError("RADIO_UNAVAILABLE", "The native helper did not open the configured radio.")
        except BaseException:
            await self.close()
            raise
        finally:
            if not connected.done():
                connected.cancel()
            if exited is not None:
                exited.cancel()
                await asyncio.gather(exited, return_exceptions=True)

    async def receive(self):
        while self.reader is not None:
            line = await self.reader.readline()
            if not line:
                raise DriverError("RADIO_UNAVAILABLE", "The native helper disconnected.")
            message = json.loads(line)
            if message.get("type") == "rx":
                data = base64.b64decode(message["data"], validate=True)
                if len(data) > 4096:
                    raise DriverError("INVALID_ARGUMENT", "Native audio message exceeds its bound.")
                yield data
            elif message.get("type") in ("error", "closed", "expired"):
                raise DriverError("RADIO_UNAVAILABLE", "Native transport stopped: " + message["type"])

    async def _send(self, message):
        if self.writer is None:
            raise DriverError("RADIO_UNAVAILABLE", "The native helper is unavailable.")
        async with self._write_lock:
            self.writer.write((json.dumps(message, separators=(",", ":")) + "\n").encode())
            await self.writer.drain()

    async def write(self, data):
        if not 0 < len(data) <= 4096:
            raise DriverError("INVALID_ARGUMENT", "Audio write exceeds the transport bound.")
        await self._send({"type": "send", "data": base64.b64encode(data).decode()})

    async def arm(self, tx_id, ttl_seconds):
        from .codec import audio_end
        await self._send({"type": "arm", "txId": tx_id, "ttlMs": min(1500, max(1, int(ttl_seconds * 1000))),
            "end": base64.b64encode(audio_end()).decode()})

    async def disarm(self):
        if self.writer is not None:
            await self._send({"type": "stop"})

    async def close(self):
        if self.writer is not None:
            self.writer.close()
            try:
                await self.writer.wait_closed()
            except (ConnectionError, BrokenPipeError):
                pass
            self.writer = None
        self.reader = None
        if self.server is not None:
            self.server.close()
            await self.server.wait_closed()
            self.server = None
        if self.process is not None:
            try:
                await asyncio.wait_for(self.process.wait(), 4)
            except TimeoutError:
                self.process.terminate()
                try:
                    await asyncio.wait_for(self.process.wait(), 3)
                except TimeoutError:
                    self.process.kill()
                    await self.process.wait()
            self.process = None
        if self.directory is not None:
            self.directory.cleanup()
            self.directory = None


def platform_transport(config: DriverConfig) -> AudioTransport:
    return MacNativeTransport(config) if sys.platform == "darwin" else LinuxRfcommTransport(config)
