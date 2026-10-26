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
        self.driver.config = replace(self.config, idle_tx_seconds=0.12, max_tx_seconds=0.25)
        grant = await self.prepare()
        absolute = self.driver.transmission.absolute_limit
        for _ in range(3):
            await asyncio.sleep(0.06)
            await self.driver.renew_tx(grant, deadline(1), 1)
            self.assertEqual(self.driver.transmission.absolute_limit, absolute)
            self.assertLessEqual(self.driver.transmission.expires, absolute)
        await asyncio.sleep(0.22)
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

    def test_string_tx_opt_in_and_invalid_limits_are_rejected(self):
        with self.assertRaises(DriverError):
            replace(self.config, allow_experimental_tx="false")
        with self.assertRaises(DriverError):
            replace(self.config, idle_tx_seconds=float("nan"))


if __name__ == "__main__":
    unittest.main()
