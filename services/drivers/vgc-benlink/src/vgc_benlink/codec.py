"""Streaming SBC/PCM conversion through bounded FFmpeg pipes."""
import asyncio
from collections.abc import Awaitable, Callable

from .model import DriverError


def sbc_frame_length(header: bytes) -> int:
    if len(header) < 4 or header[0] != 0x9C:
        raise DriverError("INVALID_ARGUMENT", "Invalid SBC stream synchronization.")
    flags, bitpool = header[1], header[2]
    blocks = 4 * (((flags >> 4) & 3) + 1)
    subbands = 8 if flags & 1 else 4
    mode = (flags >> 2) & 3
    channels = 1 if mode == 0 else 2
    bits = blocks * bitpool * (channels if mode in (0, 1) else 1)
    if mode == 3:
        bits += subbands
    return 4 + (4 * subbands * channels) // 8 + (bits + 7) // 8


class FfmpegCodec:
    def __init__(self, executable: str, on_pcm: Callable[[bytes, bool], Awaitable[None]], on_sbc: Callable[[bytes, int], Awaitable[None]]):
        self.executable = executable
        self.on_pcm = on_pcm
        self.on_sbc = on_sbc
        self.decoder = None
        self.encoder = None
        self.decode_task = None
        self.encode_task = None
        self.buffer = b""

    async def receive(self, wire: bytes):
        from benlink import protocol
        self.buffer += wire
        if len(self.buffer) > 65536:
            raise DriverError("INVALID_ARGUMENT", "Radio framing buffer exceeded its bound.")
        while self.buffer:
            message, rest = protocol.next_audio_message(self.buffer)
            if message is None:
                break
            self.buffer = rest
            if isinstance(message, protocol.AudioData):
                if self.decoder is None:
                    self.decoder = await asyncio.create_subprocess_exec(self.executable, "-v", "error", "-probesize", "32", "-analyzeduration", "0",
                        "-f", "sbc", "-i", "pipe:0", "-f", "s16le", "-ac", "1", "-ar", "32000", "-flush_packets", "1", "pipe:1",
                        stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL)
                    self.decode_task = asyncio.create_task(self._decode_output(self.decoder))
                self.decoder.stdin.write(message.sbc_data)
                await self.decoder.stdin.drain()
            elif isinstance(message, protocol.AudioEnd):
                await self.end_burst()

    async def _decode_output(self, process):
        pending = b""
        while chunk := await process.stdout.read(4096):
            pending += chunk
            while len(pending) >= 1280:
                frame, pending = pending[:1280], pending[1280:]
                await self.on_pcm(frame, False)
        if pending:
            if len(pending) % 2:
                raise DriverError("INVALID_ARGUMENT", "Decoder produced an incomplete PCM sample.")
            await self.on_pcm(pending, False)

    async def end_burst(self):
        if self.decoder is not None:
            process, task = self.decoder, self.decode_task
            self.decoder, self.decode_task = None, None
            process.stdin.close()
            try:
                await asyncio.wait_for(task, 3)
                if await process.wait() != 0:
                    raise DriverError("RADIO_UNAVAILABLE", "SBC decoder failed.")
            finally:
                if process.returncode is None:
                    process.kill()
                    await process.wait()
        await self.on_pcm(b"", True)

    async def write_pcm(self, pcm: bytes):
        if self.encoder is None:
            self.encoder = await asyncio.create_subprocess_exec(self.executable, "-v", "error", "-f", "s16le", "-ar", "32000", "-ac", "1",
                "-i", "pipe:0", "-c:a", "sbc", "-global_quality", "1888", "-sbc_delay", "0.0075", "-f", "sbc", "-flush_packets", "1", "pipe:1",
                stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL)
            self.encode_task = asyncio.create_task(self._encode_output(self.encoder))
        if self.encode_task.done():
            await self.encode_task
        self.encoder.stdin.write(pcm)
        await self.encoder.stdin.drain()

    async def _encode_output(self, process):
        pending = b""
        group = []
        while chunk := await process.stdout.read(4096):
            pending += chunk
            while len(pending) >= 4:
                size = sbc_frame_length(pending[:4])
                if len(pending) < size:
                    break
                frame, pending = pending[:size], pending[size:]
                # The configured encoder must emit mono, 32kHz, 128-sample frames.
                if frame[1] >> 6 != 1 or (frame[1] >> 2) & 3 != 0 or ((frame[1] >> 4) & 3) != 3 or not frame[1] & 1:
                    raise DriverError("CAPABILITY_UNSUPPORTED", "Encoder did not produce the validated SBC format.")
                group.append(frame)
                if len(group) == 5:
                    await self.on_sbc(b"".join(group), 640)
                    group.clear()
        if pending:
            raise DriverError("INVALID_ARGUMENT", "Encoder emitted an incomplete SBC frame.")
        if group:
            await self.on_sbc(b"".join(group), len(group) * 128)

    async def finish_encoder(self):
        if self.encoder is not None:
            process = self.encoder
            process.stdin.close()
            await asyncio.wait_for(self.encode_task, 2)
            if await process.wait() != 0:
                raise DriverError("RADIO_UNAVAILABLE", "SBC encoder failed.")

    async def stop_encoder(self):
        task, process = self.encode_task, self.encoder
        self.encode_task, self.encoder = None, None
        if task is not None:
            if not task.done():
                task.cancel()
            await asyncio.gather(task, return_exceptions=True)
        if process is not None:
            if process.returncode is None:
                process.kill()
            await process.wait()

    async def close(self):
        await self.stop_encoder()
        task, process = self.decode_task, self.decoder
        self.decode_task, self.decoder = None, None
        if task is not None:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
        if process is not None:
            if process.returncode is None:
                process.kill()
            await process.wait()


def audio_data(sbc: bytes) -> bytes:
    from benlink import protocol
    return protocol.audio_message_to_bytes(protocol.AudioData(sbc))


def audio_end() -> bytes:
    from benlink import protocol
    return protocol.audio_message_to_bytes(protocol.AudioEnd())
