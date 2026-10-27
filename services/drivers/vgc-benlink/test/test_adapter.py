import asyncio
from dataclasses import replace
from datetime import datetime, timezone
import time
import unittest
import uuid

from vgc_benlink.adapter import VgcDriver
from vgc_benlink.codec import audio_end
from vgc_benlink.model import DriverConfig, DriverError, Operation, PcmFrame, Tuning
from fakes import FakeCodec, FakeControl, FakeTransport

RADIO = "00000000-0000-4000-8000-000000000004"
OWNER = str(uuid.uuid4())
SESSION = str(uuid.uuid4())
CONTROL = str(uuid.uuid4())


def deadline(seconds):
    return datetime.fromtimestamp(time.time() + seconds, timezone.utc).isoformat().replace("+00:00", "Z")


def operation(driver, fencing=1, owner=OWNER):
    return Operation(str(uuid.uuid4()), RADIO, driver.state.generation, driver.state.revision, deadline(5), CONTROL, fencing, owner, SESSION)


class AdapterTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.control = FakeControl()
        self.transport = FakeTransport(self.control)
        self.config = DriverConfig(RADIO, "fixture-ble", "fixture-classic", working_memory=9,
            allow_experimental_tx=True, idle_tx_seconds=0.3, max_tx_seconds=0.6, drain_seconds=0)
        self.driver = VgcDriver(self.config, self.control, lambda _: self.transport, FakeCodec)
        await self.driver.connect(RADIO)

    async def asyncTearDown(self):
        await self.driver.disconnect()

    async def prepare(self):
        grant = str(uuid.uuid4())
        await self.driver.prepare_tx(operation(self.driver), grant, deadline(0.3), deadline(0.6), 1)
        return grant

    async def test_tuning_idempotency_and_generation_fencing(self):
        command = operation(self.driver)
        result = await self.driver.tune(command, Tuning(145500000))
        self.assertEqual(result.observed_tuning.rx_hz, 145500000)
        self.assertEqual(await self.driver.tune(command, Tuning(145500000)), result)
        self.assertEqual(self.control.tune_calls, 1)
        with self.assertRaises(DriverError) as conflict:
            await self.driver.tune(command, Tuning(146000000))
        self.assertEqual(conflict.exception.code, "OPERATION_CONFLICT")
        await self.driver.disconnect()
        await self.driver.connect(RADIO)
        with self.assertRaises(DriverError) as stale:
            await self.driver.tune(command, Tuning(145500000))
        self.assertEqual(stale.exception.code, "STALE_GENERATION")

    async def test_expired_and_stale_owner_commands_do_not_write(self):
        command = operation(self.driver, fencing=2)
        await self.driver.tune(command, Tuning(145500000))
        with self.assertRaises(DriverError) as stale:
            await self.driver.tune(operation(self.driver, fencing=1), Tuning(146000000))
        self.assertEqual(stale.exception.code, "CONTROL_REQUIRED")
        with self.assertRaises(DriverError) as other:
            await self.driver.tune(operation(self.driver, fencing=2, owner=str(uuid.uuid4())), Tuning(146000000))
        self.assertEqual(other.exception.code, "CONTROL_REQUIRED")
        with self.assertRaises(DriverError) as expired:
            await self.driver.tune(replace(operation(self.driver, fencing=2), deadline_utc=deadline(-1)), Tuning(146000000))
        self.assertEqual(expired.exception.code, "DEADLINE_EXCEEDED")
        self.assertEqual(self.control.tune_calls, 1)

    async def test_runtime_restart_requires_fresh_idle_epoch_before_fence_one(self):
        await self.driver.tune(operation(self.driver, fencing=7), Tuning(145500000))
        old_generation = self.driver.state.generation
        fresh_owner = str(uuid.uuid4())
        # An ordinary idempotent Connect must not erase the established owner.
        await self.driver.connect(RADIO)
        with self.assertRaises(DriverError) as old_owner:
            await self.driver.tune(operation(self.driver, owner=fresh_owner), Tuning(146000000))
        self.assertEqual(old_owner.exception.code, "CONTROL_REQUIRED")
        await self.driver.disconnect()
        self.control.tx = True
        with self.assertRaises(DriverError) as transmitting:
            await self.driver.connect(RADIO)
        self.assertEqual(transmitting.exception.code, "RADIO_STATE_UNCERTAIN")
        self.assertEqual(self.driver.state.generation, old_generation)
        self.assertEqual(self.driver._control_fencing, 7)
        self.assertEqual(self.driver.state.tx_state, "stop_unconfirmed")
        self.control.tx = False
        self.control.fail_observe = True
        with self.assertRaises(ConnectionError):
            await self.driver.connect(RADIO)
        self.assertEqual(self.driver.state.generation, old_generation)
        self.assertEqual(self.driver._control_fencing, 7)
        self.control.fail_observe = False
        state = await self.driver.connect(RADIO)
        self.assertNotEqual(state.generation, old_generation)
        self.assertEqual(state.tx_state, "idle")
        await self.driver.tune(operation(self.driver, owner=fresh_owner), Tuning(146000000))
        self.assertEqual(self.driver._control_fencing, 1)

    async def test_uncertain_disconnect_retains_owner_until_physical_idle(self):
        await self.driver.tune(operation(self.driver, fencing=5), Tuning(145500000))
        old_generation = self.driver.state.generation
        self.control.fail_observe = True
        with self.assertRaises(DriverError) as uncertain:
            await self.driver.disconnect()
        self.assertEqual(uncertain.exception.code, "RADIO_STATE_UNCERTAIN")
        self.assertEqual(self.driver.state.generation, old_generation)
        self.assertEqual(self.driver._control_fencing, 5)
        self.assertEqual(self.driver.state.tx_state, "stop_unconfirmed")
        self.control.fail_observe = False
        self.control.tx = True
        with self.assertRaises(DriverError):
            await self.driver.disconnect()
        self.assertEqual(self.driver.state.generation, old_generation)
        self.control.tx = False
        await self.driver.disconnect()
        self.assertEqual(self.driver.state.generation, old_generation)
        state = await self.driver.connect(RADIO)
        self.assertNotEqual(state.generation, old_generation)
        self.assertEqual(state.tx_state, "idle")

    async def test_tx_opt_in_is_required(self):
        self.driver.config = replace(self.config, allow_experimental_tx=False)
        with self.assertRaises(DriverError) as disabled:
            await self.prepare()
        self.assertEqual(disabled.exception.code, "CAPABILITY_UNSUPPORTED")
        self.assertFalse(self.transport.opened.is_set())

    async def test_prepare_has_no_carrier_and_end_retires_grant(self):
        grant = await self.prepare()
        self.assertFalse(self.control.tx)
        self.assertEqual(self.driver.observe_tx(grant).state, "preparing")
        revision = self.driver.transmission.tuning_revision
        await self.driver.write_tx(grant, PcmFrame("source", 0, 0, bytes(1280), revision), 1)
        self.assertTrue(self.control.tx)
        result = await self.driver.end_tx(grant, "released", 1)
        self.assertEqual(result.state, "idle")
        self.assertTrue(result.physically_confirmed)
        self.assertEqual(self.transport.writes[-2:], [audio_end(), audio_end()])
        with self.assertRaises(DriverError) as stale_end:
            await self.driver.end_tx(grant, "released", 2)
        self.assertEqual(stale_end.exception.code, "CONTROL_REQUIRED")
        with self.assertRaises(DriverError) as reused:
            await self.driver.prepare_tx(operation(self.driver), grant, deadline(0.3), deadline(0.6), 1)
        self.assertEqual(reused.exception.code, "OPERATION_CONFLICT")

    async def test_missing_heartbeat_ends_transmission_locally(self):
        self.driver.config = replace(self.config, idle_tx_seconds=0.05)
        grant = await self.prepare()
        await asyncio.sleep(0.22)
        self.assertIsNone(self.driver.transmission)
        self.assertEqual(self.driver.observe_tx(grant).state, "idle")
        self.assertTrue(self.transport.closed)
        self.assertFalse(self.control.tx)

    async def test_cancel_during_open_cannot_emit_late_audio(self):
        gate = asyncio.Event()
        self.transport.gate = gate
        grant = str(uuid.uuid4())
        preparing = asyncio.create_task(self.driver.prepare_tx(operation(self.driver), grant, deadline(0.3), deadline(0.6), 1))
        await self.transport.opened.wait()
        await self.driver.end_tx(grant, "cancelled", 1)
        gate.set()
        await asyncio.gather(preparing, return_exceptions=True)
        self.assertEqual(self.transport.writes, [])
        self.assertTrue(self.transport.closed)
        self.assertIsNone(self.driver.transmission)

    async def test_unconfirmed_stop_blocks_new_tx_until_reconciled(self):
        grant = await self.prepare()
        self.control.fail_observe = True
        result = await self.driver.end_tx(grant)
        self.assertEqual(result.state, "stop_unconfirmed")
        self.assertFalse(result.physically_confirmed)
        with self.assertRaises(DriverError):
            await self.prepare()
        self.control.fail_observe = False
        await self.driver.reconcile()
        self.assertEqual(self.driver.state.tx_state, "idle")
        self.assertTrue(self.driver.observe_tx(grant).physically_confirmed)

    async def test_external_tuning_change_stops_the_active_audio_grant(self):
        self.driver.config = replace(self.config, idle_tx_seconds=1.5, max_tx_seconds=2)
        grant = str(uuid.uuid4())
        await self.driver.prepare_tx(operation(self.driver), grant, deadline(1.5), deadline(2), 1)
        await self.driver.write_tx(grant, PcmFrame("source", 0, 0, bytes(1280), self.driver.transmission.tuning_revision), 1)
        self.control.tuning = Tuning(146520000, 146520000)
        await asyncio.sleep(0.75)
        self.assertIsNone(self.driver.transmission)
        self.assertFalse(self.control.tx)
        self.assertEqual(self.driver.state.observed_tuning.rx_hz, 146520000)
        with self.assertRaises(DriverError):
            await self.driver.write_tx(grant, PcmFrame("source", 1, 20000, bytes(1280), 1), 1)

    async def test_concurrent_prepare_cannot_replace_an_admitted_grant(self):
        gate = asyncio.Event()
        self.transport.gate = gate
        first, second = str(uuid.uuid4()), str(uuid.uuid4())
        command = operation(self.driver)
        preparing = asyncio.create_task(self.driver.prepare_tx(command, first, deadline(0.3), deadline(0.6), 1))
        await self.transport.opened.wait()
        competing = asyncio.create_task(self.driver.prepare_tx(command, second, deadline(0.3), deadline(0.6), 1))
        gate.set()
        await preparing
        with self.assertRaises(DriverError) as blocked:
            await competing
        self.assertEqual(blocked.exception.code, "CONTROL_BUSY")
        self.assertEqual(self.driver.transmission.grant_id, first)

    async def test_uncancellable_late_open_is_not_reported_physically_idle(self):
        gate = asyncio.Event()
        transport = self.transport
        async def late_open():
            transport.opened.set()
            try:
                await gate.wait()
            except asyncio.CancelledError:
                await gate.wait()
            transport.ready = True
        transport.open = late_open
        grant = str(uuid.uuid4())
        preparing = asyncio.create_task(self.driver.prepare_tx(operation(self.driver), grant, deadline(0.3), deadline(0.6), 1))
        await transport.opened.wait()
        stopped = await self.driver.end_tx(grant, "cancelled", 1)
        self.assertEqual(stopped.state, "stop_unconfirmed")
        self.assertFalse(stopped.physically_confirmed)
        self.assertEqual((await self.driver.reconcile()).tx_state, "stop_unconfirmed")
        gate.set()
        await asyncio.gather(preparing, return_exceptions=True)
        self.assertTrue(transport.closed)
        self.assertEqual(transport.writes, [])
        self.assertEqual((await self.driver.reconcile()).tx_state, "idle")

    async def test_audio_fence_sequence_and_tuning_revision_are_checked(self):
        grant = await self.prepare()
        revision = self.driver.transmission.tuning_revision
        for frame, fence in [(PcmFrame("source", 1, 0, bytes(1280), revision), 1),
                             (PcmFrame("source", 0, 0, bytes(1280), revision + 1), 1),
                             (PcmFrame("source", 0, 0, bytes(1280), revision), 2)]:
            with self.assertRaises(DriverError):
                await self.driver.write_tx(grant, frame, fence)
        self.assertEqual(self.transport.writes, [])

    async def test_renewal_cannot_extend_the_absolute_tx_limit(self):
        self.driver.config = replace(self.config, idle_tx_seconds=1, max_tx_seconds=1.2)
        grant = str(uuid.uuid4())
        await self.driver.prepare_tx(operation(self.driver), grant, deadline(1), deadline(1.2), 1)
        absolute = self.driver.transmission.absolute_limit
        for _ in range(3):
            await asyncio.sleep(0.2)
            await self.driver.renew_tx(grant, deadline(1), 1)
            self.assertEqual(self.driver.transmission.absolute_limit, absolute)
            self.assertLessEqual(self.driver.transmission.expires, absolute)
        await asyncio.sleep(0.8)
        self.assertIsNone(self.driver.transmission)
        self.assertEqual(self.driver.observe_tx(grant).state, "idle")

    async def test_rx_context_end_marker_and_overflow_are_explicit(self):
        receive = self.driver.rx(RADIO, self.driver.state.generation, "rx-stream")
        pending = asyncio.create_task(anext(receive))
        await self.transport.opened.wait()
        await asyncio.sleep(0)
        await self.driver._on_pcm(bytes(1280), False)
        first = await pending
        self.assertEqual(first.attribution_confidence, "inferred")
        self.assertEqual(first.media_time_us, 0)
        for _ in range(60):
            await self.driver._on_pcm(bytes(1280), False)
        next_frame = await anext(receive)
        self.assertGreater(next_frame.sequence, first.sequence + 1)
        self.assertTrue(next_frame.discontinuity)
        while not self.driver._subscribers["rx-stream"].empty():
            await anext(receive)
        await self.driver._on_pcm(b"", True)
        self.assertTrue((await anext(receive)).end_of_burst)
        await receive.aclose()

    async def test_verified_tuning_returns_before_delayed_receive_reopening(self):
        self.driver._subscribers["fixture-listener"] = asyncio.Queue(maxsize=50)
        gate = asyncio.Event()
        reopening = FakeTransport(self.control, gate)
        self.driver.transport_factory = lambda _: reopening
        changed = await asyncio.wait_for(self.driver.tune(operation(self.driver), Tuning(145500000)), 0.5)
        self.assertEqual(changed.observed_tuning.rx_hz, 145500000)
        self.assertEqual(changed.tuning_confidence, "confirmed")
        await reopening.opened.wait()
        self.assertFalse(reopening.ready)
        self.assertEqual(self.control.tune_calls, 1)
        gate.set()
        await asyncio.gather(*self.driver._rx_resumes)
        self.assertTrue(reopening.ready)

    async def test_failed_receive_reopening_publishes_gap_and_preserves_applied_tuning(self):
        queue = asyncio.Queue(maxsize=50)
        self.driver._subscribers["fixture-listener"] = queue
        broken = FakeTransport(self.control)
        async def fail_open():
            raise ConnectionError("Fixture receive opening failed.")
        broken.open = fail_open
        self.driver.transport_factory = lambda _: broken
        changed = await self.driver.tune(operation(self.driver), Tuning(145500000))
        await asyncio.gather(*self.driver._rx_resumes)
        self.assertEqual(changed.tuning_confidence, "confirmed")
        self.assertEqual(self.driver.state.observed_tuning.rx_hz, 145500000)
        self.assertEqual(self.driver.state.connection, "degraded")
        gap, failure = queue.get_nowait(), queue.get_nowait()
        self.assertTrue(gap["discontinuity"] and gap["end_of_burst"])
        self.assertIsInstance(failure, DriverError)
        self.assertEqual(self.driver._events[-1]["snapshot"].connection, "degraded")

    async def test_superseded_receive_reopening_cannot_attach_late(self):
        self.driver._subscribers["fixture-listener"] = asyncio.Queue(maxsize=50)
        gate = asyncio.Event()
        late = FakeTransport(self.control)
        async def late_open():
            late.opened.set()
            try:
                await gate.wait()
            except asyncio.CancelledError:
                await gate.wait()
            late.ready = True
        late.open = late_open
        current = FakeTransport(self.control)
        transports = iter([late, current])
        self.driver.transport_factory = lambda _: next(transports)
        await self.driver.tune(operation(self.driver), Tuning(145500000))
        await late.opened.wait()
        await self.driver.tune(operation(self.driver), Tuning(146520000))
        gate.set()
        await asyncio.gather(*self.driver._rx_resumes)
        self.assertTrue(late.closed)
        self.assertEqual(late.writes, [])
        self.assertIs(self.driver.transport, current)
        self.assertTrue(current.ready)
        self.assertEqual(self.driver.state.connection, "ready")
        self.assertEqual(self.driver.state.observed_tuning.rx_hz, 146520000)

    async def test_late_encoder_io_blocks_idle_and_cannot_replay_into_another_grant(self):
        started, release = asyncio.Event(), asyncio.Event()
        codecs = []
        class LateCodec(FakeCodec):
            async def write_pcm(codec, pcm):
                started.set()
                while not release.is_set():
                    try:
                        await release.wait()
                    except asyncio.CancelledError:
                        continue
                await codec.on_sbc(b"late-encoder-audio", 640)
        def factory(*args):
            codec = LateCodec(*args)
            codecs.append(codec)
            return codec
        self.driver.codec_factory = factory
        grant = await self.prepare()
        frame = PcmFrame("source", 0, 0, bytes(1280), self.driver.transmission.tuning_revision)
        writing = asyncio.create_task(self.driver.write_tx(grant, frame, 1))
        await started.wait()
        ending = await self.driver.end_tx(grant, "cancelled", 1)
        self.assertEqual(ending.state, "stop_unconfirmed")
        self.assertEqual((await self.driver.reconcile()).tx_state, "stop_unconfirmed")
        with self.assertRaises(DriverError):
            await self.prepare()
        release.set()
        await asyncio.gather(writing, return_exceptions=True)
        await asyncio.gather(*self.driver._codec_cleanups)
        self.assertEqual(self.transport.writes, [audio_end(), audio_end()])
        self.assertEqual((await self.driver.reconcile()).tx_state, "idle")
        fresh = FakeTransport(self.control)
        self.driver.transport_factory = lambda _: fresh
        next_grant = await self.prepare()
        await codecs[0].on_sbc(b"retired-encoder-callback", 640)
        self.assertEqual(fresh.writes, [])
        await self.driver.end_tx(next_grant)

    async def test_uncancellable_native_write_prevents_idle_proof_until_settled(self):
        started, release = asyncio.Event(), asyncio.Event()
        original_write = self.transport.write
        async def delayed_write(data):
            if data != audio_end():
                started.set()
                while not release.is_set():
                    try:
                        await release.wait()
                    except asyncio.CancelledError:
                        continue
            await original_write(data)
        self.transport.write = delayed_write
        grant = await self.prepare()
        frame = PcmFrame("source", 0, 0, bytes(1280), self.driver.transmission.tuning_revision)
        writing = asyncio.create_task(self.driver.write_tx(grant, frame, 1))
        await started.wait()
        ending = await self.driver.end_tx(grant, "cancelled", 1)
        self.assertFalse(ending.physically_confirmed)
        self.assertEqual((await self.driver.reconcile()).tx_state, "stop_unconfirmed")
        release.set()
        await asyncio.gather(writing, return_exceptions=True)
        await asyncio.gather(*self.driver._codec_cleanups)
        self.assertEqual(self.transport.writes, [audio_end(), audio_end()])
        self.assertEqual((await self.driver.reconcile()).tx_state, "idle")

    async def test_verified_tx_end_returns_before_rx_only_open_and_stays_idle(self):
        grant = await self.prepare()
        self.driver._subscribers["fixture-listener"] = asyncio.Queue(maxsize=50)
        release = asyncio.Event()
        receiver = FakeTransport(self.control, release)
        self.driver.transport_factory = lambda _: receiver
        ending = await asyncio.wait_for(self.driver.end_tx(grant, "released", 1), 0.5)
        self.assertTrue(ending.physically_confirmed)
        self.assertEqual(ending.state, "idle")
        await receiver.opened.wait()
        self.assertFalse(receiver.ready)
        self.assertEqual((await self.driver.reconcile()).tx_state, "idle")
        release.set()
        await asyncio.gather(*self.driver._rx_resumes)
        self.assertEqual(receiver.arms, [])

    async def test_reconcile_does_not_report_idle_while_termination_write_is_pending(self):
        grant = await self.prepare()
        started, release = asyncio.Event(), asyncio.Event()
        original_write = self.transport.write
        async def delayed_end(data):
            if data == audio_end():
                started.set()
                await release.wait()
            await original_write(data)
        self.transport.write = delayed_end
        ending = asyncio.create_task(self.driver.end_tx(grant, "released", 1))
        await started.wait()
        self.assertEqual((await self.driver.reconcile()).tx_state, "stopping")
        release.set()
        self.assertEqual((await ending).state, "idle")

    def test_string_tx_opt_in_and_invalid_limits_are_rejected(self):
        with self.assertRaises(DriverError):
            replace(self.config, allow_experimental_tx="false")
        with self.assertRaises(DriverError):
            replace(self.config, idle_tx_seconds=float("nan"))


if __name__ == "__main__":
    unittest.main()
