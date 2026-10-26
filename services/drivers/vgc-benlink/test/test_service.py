import asyncio
from pathlib import Path
import tempfile
import unittest
import uuid

import grpc

from fakes import FakeCodec, FakeControl, FakeTransport
from test_adapter import CONTROL, OWNER, RADIO, SESSION, deadline
from vgc_benlink.adapter import VgcDriver
from vgc_benlink.model import DriverConfig
from vgc_benlink.server import serve
from vgc_benlink.service import pb, rpc


class ServiceTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="sd-vgc-rpc-")
        self.socket = Path(self.directory.name) / "driver.sock"
        self.control = FakeControl()
        self.transport = FakeTransport(self.control)
        config = DriverConfig(RADIO, "ble-fixture", "classic-fixture", working_memory=9,
            allow_experimental_tx=True, idle_tx_seconds=0.5, max_tx_seconds=1, drain_seconds=0)
        self.driver = VgcDriver(config, self.control, lambda _: self.transport, FakeCodec)
        self.stop = asyncio.Event()
        self.token = "fixture-driver-token-with-at-least-32-characters"
        self.metadata = (("authorization", "Bearer " + self.token),)
        self.serving = asyncio.create_task(serve(self.driver, self.socket, self.token, self.stop))
        async def ready():
            while not self.socket.exists():
                if self.serving.done():
                    await self.serving
                await asyncio.sleep(0.005)
        await asyncio.wait_for(ready(), 3)
        self.channel = grpc.aio.insecure_channel("unix:" + str(self.socket))
        await asyncio.wait_for(self.channel.channel_ready(), 3)
        self.stub = rpc.RadioDriverServiceStub(self.channel)

    async def asyncTearDown(self):
        await self.channel.close()
        self.stop.set()
        await self.serving
        self.directory.cleanup()

    def context(self, snapshot):
        return pb.OperationContext(operation_id=str(uuid.uuid4()), radio_id=RADIO,
            generation=snapshot.generation, expected_revision=snapshot.revision, deadline_utc=deadline(5),
            control_grant=CONTROL, fencing=1, owner_id=OWNER, session_id=SESSION)

    async def test_private_grpc_authentication_connect_memory_and_tuning(self):
        with self.assertRaises(grpc.aio.AioRpcError) as denied:
            await self.stub.Describe(pb.DescribeRequest())
        self.assertEqual(denied.exception.code(), grpc.StatusCode.UNAUTHENTICATED)
        self.assertIn('"code": "UNAUTHORIZED"', denied.exception.details())
        description = await self.stub.Describe(pb.DescribeRequest(), metadata=self.metadata)
        self.assertTrue(description.capabilities.memory_read)
        self.assertEqual(description.capabilities.ptt_mechanism, "audio_coupled")
        state = await self.stub.Connect(pb.RadioRequest(radio_id=RADIO), metadata=self.metadata)
        self.assertEqual(state.connection, "ready")
        self.assertEqual(self.socket.stat().st_mode & 0o777, 0o600)
        changed = await self.stub.ApplyTuning(pb.ApplyTuningRequest(context=self.context(state), tuning=pb.Tuning(rx_hz=145500000, mode="FM")), metadata=self.metadata)
        self.assertEqual(changed.observed_tuning.rx_hz, 145500000)
        memories = await self.stub.ListMemories(pb.RadioRequest(radio_id=RADIO), metadata=self.metadata)
        self.assertEqual(memories.memories[0].memory_id, "9")
        selected = await self.stub.SelectMemory(pb.SelectMemoryRequest(context=self.context(changed), memory_id="10"), metadata=self.metadata)
        self.assertEqual(selected.selected_memory_id, "10")
        with self.assertRaises(grpc.aio.AioRpcError) as stale:
            await self.stub.ApplyTuning(pb.ApplyTuningRequest(context=self.context(state), tuning=pb.Tuning(rx_hz=146000000, mode="FM")), metadata=self.metadata)
        self.assertIn('"code": "STALE_REVISION"', stale.exception.details())

    async def test_real_streaming_rpc_fencing_and_physical_stop_observation(self):
        state = await self.stub.Connect(pb.RadioRequest(radio_id=RADIO), metadata=self.metadata)
        grant = str(uuid.uuid4())
        await self.stub.PrepareTransmission(pb.PrepareTransmissionRequest(context=self.context(state), tx_grant_id=grant,
            expires_at_utc=deadline(0.5), max_until_utc=deadline(1), fencing=1,
            format=pb.AudioFormat(sample_rate_hz=32000, channels=1, encoding="pcm_s16le")), metadata=self.metadata)
        self.assertFalse(self.control.tx)
        await self.stub.RenewTransmission(pb.RenewTransmissionRequest(radio_id=RADIO, generation=state.generation,
            tx_grant_id=grant, fencing=1, expires_at_utc=deadline(0.5)), metadata=self.metadata)
        async def frames():
            for sequence in range(2):
                yield pb.TxAudioRequest(radio_id=RADIO, generation=state.generation, tx_grant_id=grant, fencing=1,
                    frame=pb.AudioFrame(stream_id="fixture-stream", sequence=sequence, media_time_us=sequence*20000,
                        tuning_revision=state.revision, payload=bytes(1280),
                        format=pb.AudioFormat(sample_rate_hz=32000, channels=1, encoding="pcm_s16le")))
        result = await self.stub.PushTxAudio(frames(), metadata=self.metadata)
        self.assertEqual(result.state, "idle")
        self.assertTrue(result.physically_confirmed)
        self.assertFalse(self.control.tx)
        self.assertEqual(len(self.transport.writes), 4)

    async def test_stale_audio_cannot_cancel_the_current_grant(self):
        state = await self.stub.Connect(pb.RadioRequest(radio_id=RADIO), metadata=self.metadata)
        grant = str(uuid.uuid4())
        await self.stub.PrepareTransmission(pb.PrepareTransmissionRequest(context=self.context(state), tx_grant_id=grant,
            expires_at_utc=deadline(0.5), max_until_utc=deadline(1), fencing=1,
            format=pb.AudioFormat(sample_rate_hz=32000, channels=1, encoding="pcm_s16le")), metadata=self.metadata)
        async def stale():
            yield pb.TxAudioRequest(radio_id=RADIO, generation=state.generation, tx_grant_id=grant, fencing=2)
        with self.assertRaises(grpc.aio.AioRpcError) as rejected:
            await self.stub.PushTxAudio(stale(), metadata=self.metadata)
        self.assertIn('"code": "CONTROL_REQUIRED"', rejected.exception.details())
        self.assertEqual(self.driver.transmission.grant_id, grant)
        self.assertEqual(self.transport.writes, [])


if __name__ == "__main__": unittest.main()
