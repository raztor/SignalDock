"""Stateful driver with local deadlines, bounded streams and no TX replay."""
import asyncio
from collections import deque
import copy
from dataclasses import dataclass
import time
from typing import AsyncIterator
import uuid

from .codec import FfmpegCodec, audio_data, audio_end
from .control import ControlPort, ControlObservation
from .model import DriverConfig, DriverError, Memory, Operation, PcmFrame, Snapshot, Tuning, TxObservation, utc_epoch, utc_now
from .transport import AudioTransport, platform_transport


@dataclass
class Transmission:
    grant_id: str
    generation: str
    expires: float
    absolute_limit: float
    fencing: int = 0
    tuning_revision: int = 0
    input_sequence: int = -1
    next_input: float = 0
    next_output: float = 0
    stopping: bool = False
    audio_sent: bool = False


class VgcDriver:
    def __init__(self, config: DriverConfig, control: ControlPort, transport_factory=platform_transport, codec_factory=FfmpegCodec):
        self.config, self.control = config, control
        self.transport_factory, self.codec_factory = transport_factory, codec_factory
        self.state = Snapshot(config.radio_id)
        self.transport: AudioTransport | None = None
        self.codec = None
        self.transmission: Transmission | None = None
        self.last_tx = TxObservation(config.radio_id, self.state.generation, "", "idle", False)
        self._control_lock = asyncio.Lock()
        self._lifecycle_lock = asyncio.Lock()
        self._audio_lock = asyncio.Lock()
        self._stop_lock = asyncio.Lock()
        self._prepare_lock = asyncio.Lock()
        self._opening = None
        self._reader = None
        self._monitor = None
        self._watchdog = None
        self._rx_resumes: set[asyncio.Task] = set()
        self._subscribers: dict[str, asyncio.Queue] = {}
        self._watchers: set[asyncio.Queue] = set()
        self._events = deque(maxlen=256)
        self._operations = {}
        self._used_tx_grants: set[str] = set()
        self._control_fencing = 0
        self._control_owner = None
        self._last_tx_fencing = 0
        self._completed_tx_fencing = 0
        self._sequence = 0
        self._rx_sequence = 0
        self._rx_samples = 0
        self._rx_discontinuity = False

    def snapshot(self) -> Snapshot:
        return copy.deepcopy(self.state)

    def _publish(self):
        self._sequence += 1
        event = {"event_id": str(uuid.uuid4()), "sequence": self._sequence, "occurred_at_utc": utc_now(), "snapshot": self.snapshot()}
        self._events.append(event)
        for queue in list(self._watchers):
            if queue.full():
                while not queue.empty():
                    queue.get_nowait()
                queue.put_nowait(DriverError("STALE_REVISION", "Driver event window was lost; fetch a new snapshot."))
            else:
                queue.put_nowait(event)

    def _check_radio(self, radio_id: str, generation: str | None = None):
        if radio_id != self.config.radio_id:
            raise DriverError("NOT_FOUND", "Unknown radio.")
        if generation is not None and generation != self.state.generation:
            raise DriverError("STALE_GENERATION", "The driver generation changed.")

    def _check_operation(self, operation: Operation):
        self._check_radio(operation.radio_id, operation.generation)
        if not operation.control_grant or not operation.operation_id:
            raise DriverError("CONTROL_REQUIRED", "A control grant and operation ID are required.")
        if not 0 < operation.fencing <= 9007199254740991:
            raise DriverError("INVALID_ARGUMENT", "A safe positive control fencing counter is required.")
        try:
            for value in (operation.operation_id, operation.control_grant, operation.owner_id, operation.session_id):
                uuid.UUID(value)
        except (ValueError, AttributeError):
            raise DriverError("INVALID_ARGUMENT", "Command operation/grant/owner/session identifiers must be UUIDs.") from None
        owner = (operation.owner_id, operation.session_id, operation.control_grant)
        if operation.fencing < self._control_fencing or (operation.fencing == self._control_fencing and owner != self._control_owner):
            raise DriverError("CONTROL_REQUIRED", "The command has a stale control fence or another owner.")
        if utc_epoch(operation.deadline_utc) <= time.time():
            raise DriverError("DEADLINE_EXCEEDED", "The command expired.")
        if operation.expected_revision != self.state.revision:
            raise DriverError("STALE_REVISION", "Observed radio state changed.")
        if self.state.connection != "ready":
            raise DriverError("RADIO_UNAVAILABLE", "The radio is not synchronized.")
        if operation.fencing > self._control_fencing and self.transmission is not None:
            self.transmission.expires = time.monotonic()
        self._control_fencing = operation.fencing
        self._control_owner = owner

    def _apply_observation(self, observation: ControlObservation):
        selected = str(observation.memory_id) if observation.memory_id is not None else None
        previous_tx = self.state.tx_state
        changed = observation.tuning != self.state.observed_tuning or observation.confidence != self.state.tuning_confidence or selected != self.state.selected_memory_id
        self.state.observed_tuning = observation.tuning
        self.state.tuning_confidence = observation.confidence
        self.state.selected_memory_id = selected
        if observation.tx_active is True:
            if self.transmission is None or self.transmission.stopping:
                self.state.tx_state = "stop_unconfirmed"
            else:
                self.state.tx_state = "transmitting"
        elif observation.tx_active is False and self.transmission is None:
            self.state.tx_state = "stop_unconfirmed" if self._opening is not None and not self._opening.done() else "idle"
            if self.state.tx_state == "idle" and self.last_tx.tx_grant_id and self.last_tx.generation == self.state.generation:
                self.last_tx = TxObservation(self.config.radio_id, self.state.generation, self.last_tx.tx_grant_id, "idle", True)
        if changed or previous_tx != self.state.tx_state:
            self.state.revision += 1

    async def connect(self, radio_id: str) -> Snapshot:
        async with self._lifecycle_lock:
            return await self._connect(radio_id)

    async def _connect(self, radio_id: str) -> Snapshot:
        self._check_radio(radio_id)
        if self.state.connection != "disconnected":
            return self.snapshot()
        # A restarted runtime must explicitly disconnect/connect. Retain the old
        # epoch and fences until fresh hardware readback proves control is idle.
        self.state.connection = "connecting"
        try:
            async with self._control_lock:
                observation = await asyncio.wait_for(self.control.connect(), 20)
            if observation.tx_active is not False or (self._opening is not None and not self._opening.done()):
                self.state.tx_state = "stop_unconfirmed"
                raise DriverError("RADIO_STATE_UNCERTAIN", "A fresh physical idle observation and settled audio opening are required before resetting control ownership.")
            self.state = Snapshot(self.config.radio_id, connection="connecting", tx_state="unknown")
            self.last_tx = TxObservation(self.config.radio_id, self.state.generation, "", "idle", False)
            self._sequence = 0
            self._events.clear()
            self._operations.clear()
            self._used_tx_grants.clear()
            self._control_fencing = self._last_tx_fencing = 0
            self._completed_tx_fencing = 0
            self._control_owner = None
            self._rx_sequence = self._rx_samples = 0
            self._apply_observation(observation)
            self.state.connection = "ready"
            self.state.revision += 1
            self._publish()
            self._monitor = asyncio.create_task(self._observe_loop())
            self._watchdog = asyncio.create_task(self._watchdog_loop())
            return self.snapshot()
        except BaseException:
            self.state.connection = "disconnected"
            self.state.tuning_confidence = "unknown"
            self.state.tx_state = "stop_unconfirmed"
            self._publish()
            try:
                await asyncio.wait_for(self.control.disconnect(), 5)
            except BaseException:
                pass
            raise

    async def disconnect(self):
        async with self._lifecycle_lock:
            await self._disconnect()

    async def _disconnect(self):
        self._cancel_rx_resumes()
        if self.state.connection == "disconnected" and self.state.tx_state == "idle" and self.transport is None and self._opening is None:
            return
        was_disconnected = self.state.connection == "disconnected"
        if self.transmission is not None:
            await self.end_tx(self.transmission.grant_id, "driver_disconnect")
        for task in [self._monitor, self._watchdog]:
            if task is not None:
                task.cancel()
        await asyncio.gather(*(task for task in [self._monitor, self._watchdog] if task is not None), return_exceptions=True)
        self._monitor = self._watchdog = None
        await self._close_audio()
        confirmed = False
        async with self._control_lock:
            try:
                observation = await asyncio.wait_for(self.control.connect() if was_disconnected else self.control.observe(), 20 if was_disconnected else 5)
                self._apply_observation(observation)
                confirmed = observation.tx_active is False and (self._opening is None or self._opening.done())
            except BaseException:
                pass
            try:
                await asyncio.wait_for(self.control.disconnect(), 5)
            except BaseException:
                confirmed = False
        self.state.connection = "disconnected"
        self.state.tx_state = "idle" if confirmed else "stop_unconfirmed"
        self.state.revision += 1
        self._publish()
        for queue in self._subscribers.values():
            self._queue_latest(queue, None)
        self._subscribers.clear()
        if not confirmed:
            raise DriverError("RADIO_STATE_UNCERTAIN", "Disconnect could not confirm physical idle; the prior ownership epoch is retained.")

    async def reconcile(self):
        async with self._control_lock:
            observation = await asyncio.wait_for(self.control.observe(), 5)
        self._apply_observation(observation)
        self.state.connection = "ready"
        self._publish()
        return self.snapshot()

    async def tune(self, operation: Operation, tuning: Tuning) -> Snapshot:
        self._check_radio(operation.radio_id, operation.generation)
        key = operation.operation_id
        fingerprint = (operation, tuning)
        if key in self._operations:
            previous, snapshot = self._operations[key]
            if previous != fingerprint:
                raise DriverError("OPERATION_CONFLICT", "Operation ID was reused with another command.")
            return copy.deepcopy(snapshot)
        async with self._control_lock:
            self._check_operation(operation)
            if self.transmission is not None or self.state.tx_state != "idle":
                raise DriverError("CONTROL_BUSY", "Tuning is forbidden while TX is active or uncertain.")
            tuning.validate()
            resume_rx = await self._pause_rx_for_tuning()
            self.state.desired_tuning = tuning
            try:
                observation = await asyncio.wait_for(self.control.tune(tuning), max(0.001, min(15, utc_epoch(operation.deadline_utc) - time.time())))
                self._apply_observation(observation)
                self.state.revision += 1
                self._publish()
                snapshot = self.snapshot()
                self._operations[key] = (fingerprint, snapshot)
                if len(self._operations) > 256:
                    del self._operations[next(iter(self._operations))]
                if resume_rx:
                    self._defer_rx_resume()
                return snapshot
            except BaseException:
                self.state.connection = "degraded"
                self.state.tuning_confidence = "unknown"
                self.state.revision += 1
                self._publish()
                raise

    async def events(self, radio_id: str, generation: str, after: int):
        self._check_radio(radio_id, generation)
        if self._events and after and after < self._events[0]["sequence"] - 1:
            raise DriverError("STALE_REVISION", "Driver event cursor expired; fetch a new snapshot.")
        queue = asyncio.Queue(maxsize=64)
        self._watchers.add(queue)
        try:
            for event in list(self._events):
                if event["sequence"] > after:
                    self._check_radio(radio_id, event["snapshot"].generation)
                    yield event
            while True:
                event = await queue.get()
                if isinstance(event, Exception):
                    raise event
                if event["snapshot"].generation != generation:
                    raise DriverError("STALE_GENERATION", "Event stream generation changed; resubscribe.")
                yield event
        finally:
            self._watchers.discard(queue)

    async def list_memories(self) -> list[Memory]:
        async with self._control_lock:
            if self.state.connection != "ready":
                raise DriverError("RADIO_UNAVAILABLE", "The radio is not ready.")
            return await asyncio.wait_for(self.control.list_memories(), 60)

    async def read_memory(self, memory_id: str) -> Memory:
        async with self._control_lock:
            if self.state.connection != "ready":
                raise DriverError("RADIO_UNAVAILABLE", "The radio is not ready.")
            return await asyncio.wait_for(self.control.read_memory(memory_id), 5)

    async def mutate_memory(self, operation: Operation, action: str, value):
        self._check_radio(operation.radio_id, operation.generation)
        fingerprint = (operation, action, value)
        previous = self._operations.get(operation.operation_id)
        if previous is not None:
            if previous[0] != fingerprint:
                raise DriverError("OPERATION_CONFLICT", "Operation ID was reused with another memory command.")
            return copy.deepcopy(previous[1])
        async with self._control_lock:
            self._check_operation(operation)
            if self.transmission is not None or self.state.tx_state != "idle":
                raise DriverError("CONTROL_BUSY", "Memory changes are forbidden while TX is active or uncertain.")
            try:
                resume_rx = await self._pause_rx_for_tuning() if (action == "select"
                    or (action == "write" and value.memory_id == self.state.selected_memory_id) or self._rx_resumes) else False
                if action == "write":
                    result = await asyncio.wait_for(self.control.write_memory(value), max(0.001, min(15, utc_epoch(operation.deadline_utc) - time.time())))
                    observation = await asyncio.wait_for(self.control.observe(), 5)
                elif action == "select":
                    observation = await asyncio.wait_for(self.control.select_memory(value), max(0.001, min(15, utc_epoch(operation.deadline_utc) - time.time())))
                    result = None
                else:
                    raise DriverError("INVALID_ARGUMENT", "Unknown memory operation.")
                self._apply_observation(observation)
                self.state.revision += 1
                self._publish()
                if result is None:
                    result = self.snapshot()
                self._operations[operation.operation_id] = (fingerprint, copy.deepcopy(result))
                if len(self._operations) > 256:
                    del self._operations[next(iter(self._operations))]
                if resume_rx:
                    self._defer_rx_resume()
                return result
            except BaseException:
                self.state.connection = "degraded"
                self.state.tuning_confidence = "unknown"
                self.state.revision += 1
                self._publish()
                raise

    @staticmethod
    def _queue_latest(queue, value):
        dropped = queue.full()
        if dropped:
            queue.get_nowait()
        queue.put_nowait(value)
        return dropped

    async def rx(self, radio_id: str, generation: str, stream_id: str) -> AsyncIterator[PcmFrame]:
        self._check_radio(radio_id, generation)
        if self.state.connection != "ready":
            raise DriverError("RADIO_UNAVAILABLE", "Radio is not ready.")
        if stream_id in self._subscribers:
            raise DriverError("OPERATION_CONFLICT", "RX stream ID is already open.")
        if len(self._subscribers) >= 16:
            raise DriverError("CONTROL_BUSY", "The driver RX subscriber limit was reached.")
        queue = asyncio.Queue(maxsize=50)
        self._subscribers[stream_id] = queue
        last_sequence = None
        try:
            await self._ensure_audio()
            while True:
                frame = await queue.get()
                if frame is None:
                    return
                if isinstance(frame, Exception):
                    raise frame
                if last_sequence is not None and frame["sequence"] != last_sequence + 1:
                    frame = {**frame, "discontinuity": True}
                last_sequence = frame["sequence"]
                yield PcmFrame(stream_id=stream_id, **frame)
        finally:
            if self._subscribers.get(stream_id) is queue:
                self._subscribers.pop(stream_id, None)
            if not self._subscribers and self.transmission is None:
                await self._close_audio()

    async def _pause_rx_for_tuning(self):
        pending = any(not task.done() for task in self._rx_resumes)
        self._cancel_rx_resumes()
        if self.transport is not None or pending:
            await self._close_audio()
            self._rx_discontinuity = True
            await self._on_pcm(b"", True)
        return bool(self._subscribers)

    def _cancel_rx_resumes(self):
        for task in tuple(self._rx_resumes):
            if task is not asyncio.current_task():
                task.cancel()

    def _defer_rx_resume(self):
        task = asyncio.create_task(self._resume_rx(self.state.generation, self.state.revision))
        self._rx_resumes.add(task)
        task.add_done_callback(self._rx_resumes.discard)

    async def _resume_rx(self, generation, revision):
        def current():
            return (self.state.generation == generation and self.state.revision == revision
                and self.state.connection == "ready" and self.transmission is None and bool(self._subscribers))
        if not current():
            return
        try:
            await self._ensure_audio((generation, revision))
        except asyncio.CancelledError:
            return
        except BaseException:
            if not current():
                return
            self._rx_discontinuity = True
            await self._on_pcm(b"", True)
            self.state.connection = "degraded"
            self.state.revision += 1
            self._publish()
            for queue in self._subscribers.values():
                self._queue_latest(queue, DriverError("RADIO_UNAVAILABLE", "Receive stream could not resume after verified tuning."))

    async def _ensure_audio(self, expected_context=None):
        async with self._audio_lock:
            if expected_context is not None and expected_context != (self.state.generation, self.state.revision):
                raise DriverError("STALE_REVISION", "Receive reopening belongs to a superseded radio context.")
            if self.transport is not None:
                return
            transport = self.transport_factory(self.config)
            self.transport = transport
            opening = asyncio.create_task(transport.open())
            self._opening = opening
            try:
                await asyncio.wait_for(opening, self.config.audio_open_timeout)
                if (self.transport is not transport or self.state.connection != "ready"
                        or (expected_context is not None and expected_context != (self.state.generation, self.state.revision))):
                    await transport.close()
                    raise DriverError("DEADLINE_EXCEEDED", "The audio opening was cancelled before completion.")
                self.codec = self.codec_factory(self.config.ffmpeg, self._on_pcm, self._on_sbc)
                self._reader = asyncio.create_task(self._read_audio(transport))
            except BaseException:
                await transport.close()
                self.transport = None
                raise
            finally:
                if self._opening is opening:
                    self._opening = None

    async def _read_audio(self, transport):
        try:
            async for data in transport.receive():
                await self.codec.receive(data)
        except asyncio.CancelledError:
            raise
        except BaseException as error:
            self._rx_discontinuity = True
            for queue in self._subscribers.values():
                self._queue_latest(queue, DriverError("RADIO_UNAVAILABLE", "Radio audio stream failed."))
            if self.transmission is not None:
                await self.end_tx(self.transmission.grant_id, "audio_link_failed")
            else:
                await self._close_audio()

    async def _close_audio(self):
        opening = self._opening
        if opening is not None and opening is not asyncio.current_task():
            opening.cancel()
        reader, self._reader = self._reader, None
        if reader is not None and reader is not asyncio.current_task():
            reader.cancel()
            await asyncio.gather(reader, return_exceptions=True)
        codec, self.codec = self.codec, None
        if codec is not None:
            await codec.close()
        transport, self.transport = self.transport, None
        if transport is not None:
            await transport.close()

    async def _on_pcm(self, payload: bytes, end: bool):
        frame = {"sequence": self._rx_sequence, "media_time_us": self._rx_samples * 1_000_000 // 32000,
            "payload": payload, "tuning_revision": self.state.revision,
            "attribution_confidence": "inferred" if self.state.tuning_confidence == "confirmed" else "unknown",
            "discontinuity": self._rx_discontinuity, "end_of_burst": end}
        self._rx_sequence += 1
        self._rx_samples += len(payload) // 2
        self._rx_discontinuity = False
        for queue in self._subscribers.values():
            queued = frame
            if queue.full():
                queue.get_nowait()
                queued = {**frame, "discontinuity": True}
            queue.put_nowait(queued)

    async def prepare_tx(self, operation: Operation, grant_id: str, expires_utc: str, max_until_utc: str, fencing: int) -> TxObservation:
        async with self._prepare_lock:
            return await self._prepare_tx(operation, grant_id, expires_utc, max_until_utc, fencing)

    async def _prepare_tx(self, operation: Operation, grant_id: str, expires_utc: str, max_until_utc: str, fencing: int) -> TxObservation:
        self._check_operation(operation)
        if not self.config.allow_experimental_tx:
            raise DriverError("CAPABILITY_UNSUPPORTED", "Streaming TX is disabled until explicitly enabled for hardware acceptance.")
        if self.transmission is not None or self.state.tx_state != "idle":
            raise DriverError("CONTROL_BUSY", "A transmission is already active or stop is unconfirmed.")
        try:
            uuid.UUID(grant_id)
        except ValueError:
            raise DriverError("INVALID_ARGUMENT", "TX grant must be a UUID.") from None
        if grant_id in self._used_tx_grants:
            raise DriverError("OPERATION_CONFLICT", "A retired TX grant cannot start another transmission.")
        if len(self._used_tx_grants) >= 10000:
            raise DriverError("REQUIRES_CONFIGURATION", "Reconnect the driver before issuing additional TX grants.")
        if fencing != operation.fencing or fencing < self._last_tx_fencing:
            raise DriverError("CONTROL_REQUIRED", "TX fence must match the active non-stale control lease.")
        remaining = min(utc_epoch(expires_utc) - time.time(), self.config.idle_tx_seconds)
        if remaining <= 0:
            raise DriverError("DEADLINE_EXCEEDED", "TX grant already expired.")
        async with self._control_lock:
            await asyncio.wait_for(self.control.tx_ready(), 5)
        self._check_operation(operation)
        remaining = min(utc_epoch(expires_utc) - time.time(), self.config.idle_tx_seconds)
        if remaining <= 0:
            raise DriverError("DEADLINE_EXCEEDED", "TX grant expired during device validation.")
        now = time.monotonic()
        absolute_remaining = min(utc_epoch(max_until_utc) - time.time(), self.config.max_tx_seconds)
        if absolute_remaining <= 0 or utc_epoch(expires_utc) > utc_epoch(max_until_utc):
            raise DriverError("DEADLINE_EXCEEDED", "TX absolute deadline is invalid or expired.")
        tx = Transmission(grant_id, self.state.generation, now + remaining, now + absolute_remaining,
            fencing=fencing, tuning_revision=operation.expected_revision)
        self.transmission = tx
        self._used_tx_grants.add(grant_id)
        self._last_tx_fencing = fencing
        self.state.tx_state = "preparing"
        self._publish()
        try:
            await self._ensure_audio()
            self._assert_tx(grant_id)
            await self.transport.arm(grant_id, tx.expires - time.monotonic())
            return self.observe_tx(grant_id)
        except BaseException:
            await self.end_tx(grant_id, "prepare_failed")
            raise

    def _assert_tx(self, grant_id: str, fencing: int | None = None) -> Transmission:
        tx = self.transmission
        if tx is None or tx.grant_id != grant_id or tx.stopping or tx.generation != self.state.generation:
            raise DriverError("CONTROL_REQUIRED", "A current TX grant is required.")
        if tx.fencing != self._control_fencing or (fencing is not None and fencing != tx.fencing):
            raise DriverError("CONTROL_REQUIRED", "TX fencing no longer matches its control owner.")
        if time.monotonic() >= min(tx.expires, tx.absolute_limit):
            raise DriverError("DEADLINE_EXCEEDED", "The local TX deadline expired.")
        return tx

    async def renew_tx(self, grant_id: str, expires_utc: str, fencing: int):
        tx = self._assert_tx(grant_id, fencing)
        remaining = min(utc_epoch(expires_utc) - time.time(), self.config.idle_tx_seconds)
        if remaining <= 0:
            raise DriverError("DEADLINE_EXCEEDED", "The renewed TX grant expired.")
        tx.expires = min(time.monotonic() + remaining, tx.absolute_limit)
        if self.transport is not None and self._opening is None:
            await self.transport.arm(grant_id, tx.expires - time.monotonic())
        return self.observe_tx(grant_id)

    async def write_tx(self, grant_id: str, frame: PcmFrame, fencing: int):
        frame.validate()
        tx = self._assert_tx(grant_id, fencing)
        if frame.tuning_revision != tx.tuning_revision:
            raise DriverError("STALE_REVISION", "TX audio belongs to another tuning revision.")
        if frame.sequence != tx.input_sequence + 1:
            raise DriverError("INVALID_ARGUMENT", "TX audio sequence must be contiguous from zero.")
        duration = len(frame.payload) / 64000
        await asyncio.sleep(max(0, tx.next_input - time.monotonic()))
        self._assert_tx(grant_id)
        tx.next_input = max(tx.next_input, time.monotonic()) + duration
        tx.input_sequence = frame.sequence
        await self.codec.write_pcm(frame.payload)

    async def _on_sbc(self, payload: bytes, samples: int):
        tx = self.transmission
        if tx is None:
            return
        self._assert_tx(tx.grant_id)
        await asyncio.sleep(max(0, tx.next_output - time.monotonic()))
        self._assert_tx(tx.grant_id)
        tx.next_output = max(tx.next_output, time.monotonic()) + samples / 32000
        await self.transport.write(audio_data(payload))
        tx.audio_sent = True

    def observe_tx(self, grant_id: str) -> TxObservation:
        if self.transmission is not None and self.transmission.grant_id == grant_id:
            return TxObservation(self.config.radio_id, self.state.generation, grant_id, self.state.tx_state,
                self.state.tx_state == "transmitting")
        if self.last_tx.tx_grant_id != grant_id:
            raise DriverError("NOT_FOUND", "Unknown TX grant.")
        return self.last_tx

    async def end_tx(self, grant_id: str, reason: str = "released", fencing: int | None = None) -> TxObservation:
        async with self._stop_lock:
            tx = self.transmission
            if tx is None or tx.grant_id != grant_id:
                if self.last_tx.tx_grant_id == grant_id and fencing is not None and fencing != self._completed_tx_fencing:
                    raise DriverError("CONTROL_REQUIRED", "The completed TX grant fence does not match.")
                return self.observe_tx(grant_id)
            if fencing is not None and fencing != tx.fencing:
                raise DriverError("CONTROL_REQUIRED", "A stale TX owner cannot end another transmission.")
            # A normal source EOF may flush its final codec frames, but release/expiry never does.
            if reason == "stream_complete" and self.codec is not None:
                try:
                    await asyncio.wait_for(self.codec.finish_encoder(), max(0.001, min(2, tx.expires - time.monotonic())))
                except BaseException:
                    pass
            tx.stopping = True
            self.state.tx_state = "stopping"
            self._publish()
            stopped = False
            try:
                if self.codec is not None:
                    await self.codec.stop_encoder()
                if self.transport is not None and self._opening is None:
                    await asyncio.wait_for(self.transport.write(audio_end()), 1)
                    await asyncio.sleep(0.1)
                    await asyncio.wait_for(self.transport.write(audio_end()), 1)
                    await self.transport.disarm()
                    if tx.audio_sent:
                        await asyncio.sleep(self.config.drain_seconds)
                await self._close_audio()
                async with self._control_lock:
                    observation = await asyncio.wait_for(self.control.observe(), 5)
                self._apply_observation(observation)
                stopped = observation.tx_active is False and (self._opening is None or self._opening.done())
            except BaseException:
                await self._close_audio()
            self.transmission = None
            self.state.tx_state = "idle" if stopped else "stop_unconfirmed"
            self.last_tx = TxObservation(self.config.radio_id, self.state.generation, grant_id, self.state.tx_state, stopped)
            self._completed_tx_fencing = tx.fencing
            self._publish()
            if self._subscribers and stopped and self.state.connection == "ready":
                try:
                    await self._ensure_audio()
                    self._rx_discontinuity = True
                except BaseException:
                    for queue in self._subscribers.values():
                        self._queue_latest(queue, DriverError("RADIO_UNAVAILABLE", "Receive stream could not resume after TX."))
            return self.last_tx

    async def _observe_loop(self):
        try:
            while True:
                await asyncio.sleep(0.5)
                previous = self.snapshot()
                async with self._control_lock:
                    observation = await asyncio.wait_for(self.control.observe(), 5)
                selected = str(observation.memory_id) if observation.memory_id is not None else None
                changed_context = observation.tuning != self.state.observed_tuning or observation.confidence != self.state.tuning_confidence or selected != self.state.selected_memory_id
                resume_rx = False
                if changed_context:
                    if self.transmission is not None:
                        await self.end_tx(self.transmission.grant_id, "external_tuning_change")
                    else:
                        resume_rx = await self._pause_rx_for_tuning()
                self._apply_observation(observation)
                if self.state != previous:
                    self._publish()
                if resume_rx:
                    await self._ensure_audio()
        except asyncio.CancelledError:
            raise
        except BaseException:
            self.state.connection = "degraded"
            self.state.tuning_confidence = "unknown"
            if self.transmission is not None:
                await self.end_tx(self.transmission.grant_id, "control_link_failed")
            self._publish()

    async def _watchdog_loop(self):
        while True:
            await asyncio.sleep(0.025)
            tx = self.transmission
            if tx is not None and not tx.stopping and time.monotonic() >= min(tx.expires, tx.absolute_limit):
                await self.end_tx(tx.grant_id, "local_deadline_expired")
