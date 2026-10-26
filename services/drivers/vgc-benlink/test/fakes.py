"""Deterministic transport/control fixtures. Never open Bluetooth."""
import asyncio
from dataclasses import replace

from vgc_benlink.codec import audio_end
from vgc_benlink.control import ControlObservation
from vgc_benlink.model import Memory, Tuning


class FakeControl:
    def __init__(self):
        self.tuning = Tuning(147540000, 147540000)
        self.tx = False
        self.connected = False
        self.tune_calls = 0
        self.fail_observe = False
        self.memory = "9"

    async def connect(self):
        self.connected = True
        return await self.observe()

    async def disconnect(self):
        self.connected = False

    async def observe(self):
        if self.fail_observe:
            raise ConnectionError("Fixture control link is unavailable.")
        return ControlObservation(self.tuning, self.tx, "confirmed", int(self.memory), 0)

    async def tune(self, tuning):
        self.tuning = tuning
        self.tune_calls += 1
        return await self.observe()

    async def tx_ready(self):
        if self.tx:
            raise RuntimeError("Fixture already transmitting.")

    async def list_memories(self):
        return [Memory("9", "Fixture", self.tuning)]

    async def read_memory(self, memory_id):
        return Memory(memory_id, "Fixture", self.tuning)

    async def write_memory(self, memory):
        self.tuning = memory.tuning
        return memory

    async def select_memory(self, memory_id):
        self.memory = memory_id
        return await self.observe()


class FakeTransport:
    def __init__(self, control, gate=None):
        self.control = control
        self.gate = gate
        self.opened = asyncio.Event()
        self.ready = False
        self.closed = False
        self.writes = []
        self.arms = []
        self.incoming = asyncio.Queue()

    async def open(self):
        self.opened.set()
        if self.gate is not None:
            await self.gate.wait()
        self.ready = True

    async def receive(self):
        while True:
            yield await self.incoming.get()

    async def write(self, data):
        if not self.ready or self.closed:
            raise ConnectionError("Fixture audio link is closed.")
        self.writes.append(data)
        self.control.tx = data != audio_end()

    async def arm(self, tx_id, ttl_seconds):
        self.arms.append((tx_id, ttl_seconds))

    async def disarm(self):
        self.control.tx = False

    async def close(self):
        self.ready = False
        self.closed = True


class FakeCodec:
    def __init__(self, executable, on_pcm, on_sbc):
        self.on_pcm, self.on_sbc = on_pcm, on_sbc
        self.inputs = []

    async def receive(self, wire):
        await self.on_pcm(wire, False)

    async def write_pcm(self, pcm):
        self.inputs.append(pcm)
        await self.on_sbc(b"fixture-sbc", len(pcm) // 2)

    async def finish_encoder(self):
        pass

    async def stop_encoder(self):
        pass

    async def close(self):
        pass
