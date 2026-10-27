"""Authenticated grpc.aio service for one explicitly configured radio."""
import asyncio
import hmac
import json
import grpc

from .adapter import VgcDriver
from .model import DriverError, Memory, Operation, PcmFrame, Tuning
from .wire import bindings

pb, rpc = bindings()


def snapshot_message(value):
    output = pb.RadioSnapshot(radio_id=value.radio_id, generation=value.generation, revision=value.revision,
        connection=value.connection, tuning_confidence=value.tuning_confidence, tx_state=value.tx_state)
    for field, tuning in [("observed_tuning", value.observed_tuning), ("desired_tuning", value.desired_tuning)]:
        if tuning is not None:
            wire = pb.Tuning(rx_hz=tuning.rx_hz, mode=tuning.mode)
            if tuning.tx_hz is not None:
                wire.tx_hz = tuning.tx_hz
            getattr(output, field).CopyFrom(wire)
    if value.selected_memory_id is not None:
        output.selected_memory_id = value.selected_memory_id
    return output


def operation_message(context):
    return Operation(context.operation_id, context.radio_id, context.generation, context.expected_revision, context.deadline_utc,
        context.control_grant, context.fencing, context.owner_id, context.session_id)


def memory_message(value):
    tuning = pb.Tuning(rx_hz=value.tuning.rx_hz, mode=value.tuning.mode)
    if value.tuning.tx_hz is not None:
        tuning.tx_hz = value.tuning.tx_hz
    return pb.Memory(memory_id=value.memory_id, name=value.name, tuning=tuning)


def tx_message(value):
    return pb.TransmissionState(radio_id=value.radio_id, generation=value.generation, tx_grant_id=value.tx_grant_id,
        state=value.state, physically_confirmed=value.physically_confirmed)


class VgcService(rpc.RadioDriverServiceServicer):
    def __init__(self, driver: VgcDriver, token: str | None):
        self.driver, self.token = driver, token
        self._push_streams = set()

    async def authorize(self, context):
        if self.token is not None:
            supplied = dict(context.invocation_metadata()).get("authorization", "")
            if not isinstance(supplied, str) or not supplied.isascii() or not hmac.compare_digest(supplied, "Bearer " + self.token):
                await context.abort(grpc.StatusCode.UNAUTHENTICATED, json.dumps({"code": "UNAUTHORIZED", "message": "Driver credentials are invalid."}))

    async def fail(self, context, error):
        if isinstance(error, DriverError):
            code, message = error.code, str(error)
        elif isinstance(error, TimeoutError):
            code, message = "DEADLINE_EXCEEDED", "The hardware operation timed out."
        else:
            code, message = "RADIO_UNAVAILABLE", "The hardware operation failed."
        status = {
            "NOT_FOUND": grpc.StatusCode.NOT_FOUND,
            "INVALID_ARGUMENT": grpc.StatusCode.INVALID_ARGUMENT,
            "CAPABILITY_UNSUPPORTED": grpc.StatusCode.UNIMPLEMENTED,
            "CONTROL_REQUIRED": grpc.StatusCode.PERMISSION_DENIED,
            "FORBIDDEN": grpc.StatusCode.PERMISSION_DENIED,
            "CONTROL_BUSY": grpc.StatusCode.ABORTED,
            "STALE_REVISION": grpc.StatusCode.ABORTED,
            "STALE_GENERATION": grpc.StatusCode.ABORTED,
            "OPERATION_CONFLICT": grpc.StatusCode.ALREADY_EXISTS,
            "DEADLINE_EXCEEDED": grpc.StatusCode.DEADLINE_EXCEEDED,
            "RADIO_STATE_UNCERTAIN": grpc.StatusCode.FAILED_PRECONDITION,
        }.get(code, grpc.StatusCode.UNAVAILABLE)
        await context.abort(status, json.dumps({"code": code, "message": message}))

    async def unary(self, context, action):
        await self.authorize(context)
        try:
            return await action()
        except asyncio.CancelledError:
            raise
        except BaseException as error:
            await self.fail(context, error)

    async def Describe(self, request, context):
        async def action():
            return pb.DescribeResponse(driver_id="vgc-benlink", version="0.1.0", protocol_min=1, protocol_max=1,
                verified_models=["VR-N7500"], capabilities=pb.RadioCapabilities(
                    tuning_writable=self.driver.config.working_memory is not None,
                    tuning_ranges=[pb.FrequencyRange(min_hz=136000000, max_hz=174000000), pb.FrequencyRange(min_hz=400000000, max_hz=470000000)],
                    modes=["FM"], rx_audio=True, tx_audio=self.driver.config.allow_experimental_tx,
                    ptt_mechanism="audio_coupled" if self.driver.config.allow_experimental_tx else "unsupported",
                    physical_tx_observation=True, independently_receivable_channels=1, verification="experimental",
                    memory_read=True, memory_write=True, memory_select=True))
        return await self.unary(context, action)

    async def ListMemories(self, request, context):
        async def action():
            self.driver._check_radio(request.radio_id)
            return pb.ListMemoriesResponse(memories=[memory_message(value) for value in await self.driver.list_memories()])
        return await self.unary(context, action)

    async def ReadMemory(self, request, context):
        async def action():
            self.driver._check_radio(request.radio_id)
            return memory_message(await self.driver.read_memory(request.memory_id))
        return await self.unary(context, action)

    async def WriteMemory(self, request, context):
        async def action():
            raw = request.memory
            value = Memory(raw.memory_id, raw.name, Tuning(raw.tuning.rx_hz,
                raw.tuning.tx_hz if raw.tuning.HasField("tx_hz") else None, raw.tuning.mode))
            return memory_message(await self.driver.mutate_memory(operation_message(request.context), "write", value))
        return await self.unary(context, action)

    async def SelectMemory(self, request, context):
        async def action():
            return snapshot_message(await self.driver.mutate_memory(operation_message(request.context), "select", request.memory_id))
        return await self.unary(context, action)

    async def Connect(self, request, context):
        async def action():
            return snapshot_message(await self.driver.connect(request.radio_id))
        return await self.unary(context, action)

    async def Disconnect(self, request, context):
        async def action():
            self.driver._check_radio(request.radio_id)
            await self.driver.disconnect()
            return pb.DisconnectResponse()
        return await self.unary(context, action)

    async def GetSnapshot(self, request, context):
        async def action():
            self.driver._check_radio(request.radio_id)
            return snapshot_message(self.driver.snapshot())
        return await self.unary(context, action)

    async def Reconcile(self, request, context):
        async def action():
            self.driver._check_radio(request.radio_id)
            return snapshot_message(await self.driver.reconcile())
        return await self.unary(context, action)

    async def ApplyTuning(self, request, context):
        async def action():
            tuning = Tuning(request.tuning.rx_hz, request.tuning.tx_hz if request.tuning.HasField("tx_hz") else None, request.tuning.mode)
            return snapshot_message(await self.driver.tune(operation_message(request.context), tuning))
        return await self.unary(context, action)

    async def WatchEvents(self, request, context):
        await self.authorize(context)
        try:
            async for event in self.driver.events(request.radio_id, request.generation, request.after_sequence):
                yield pb.RadioEvent(protocol_version=1, event_id=event["event_id"], radio_id=request.radio_id,
                    generation=event["snapshot"].generation, sequence=event["sequence"], occurred_at_utc=event["occurred_at_utc"],
                    snapshot=snapshot_message(event["snapshot"]))
        except asyncio.CancelledError:
            raise
        except BaseException as error:
            await self.fail(context, error)

    async def OpenRxStream(self, request, context):
        await self.authorize(context)
        try:
            async for frame in self.driver.rx(request.radio_id, request.generation, request.stream_id):
                value = pb.AudioFrame(stream_id=frame.stream_id, sequence=frame.sequence, media_time_us=frame.media_time_us,
                    payload=frame.payload, tuning_revision=frame.tuning_revision, attribution_confidence=frame.attribution_confidence,
                    discontinuity=frame.discontinuity, format=pb.AudioFormat(sample_rate_hz=32000, channels=1, encoding="pcm_s16le"))
                if "end_of_burst" in value.DESCRIPTOR.fields_by_name:
                    value.end_of_burst = frame.end_of_burst
                yield value
        except asyncio.CancelledError:
            raise
        except BaseException as error:
            await self.fail(context, error)

    async def PrepareTransmission(self, request, context):
        async def action():
            if (request.format.encoding, request.format.sample_rate_hz, request.format.channels) != ("pcm_s16le", 32000, 1):
                raise DriverError("CAPABILITY_UNSUPPORTED", "Requested format is unsupported.")
            return tx_message(await self.driver.prepare_tx(operation_message(request.context), request.tx_grant_id, request.expires_at_utc,
                request.max_until_utc, request.fencing))
        return await self.unary(context, action)

    async def PushTxAudio(self, request_iterator, context):
        await self.authorize(context)
        grant = None
        fencing = None
        completed = False
        try:
            async for request in request_iterator:
                self.driver._check_radio(request.radio_id, request.generation)
                if grant is not None and grant != request.tx_grant_id:
                    raise DriverError("INVALID_ARGUMENT", "A TX stream cannot change grant ownership.")
                if grant is None:
                    self.driver._assert_tx(request.tx_grant_id, request.fencing)
                    if request.tx_grant_id in self._push_streams:
                        raise DriverError("CONTROL_BUSY", "Another audio stream already owns this transmission.")
                    grant, fencing = request.tx_grant_id, request.fencing
                    self._push_streams.add(grant)
                frame = request.frame
                await self.driver.write_tx(grant, PcmFrame(frame.stream_id, frame.sequence, frame.media_time_us, frame.payload,
                    frame.tuning_revision, frame.attribution_confidence, frame.discontinuity, frame.format.sample_rate_hz,
                    frame.format.channels, frame.format.encoding), request.fencing)
            if grant is None:
                raise DriverError("INVALID_ARGUMENT", "The TX stream was empty.")
            result = await self.driver.end_tx(grant, "stream_complete", fencing)
            completed = True
            return tx_message(result)
        except asyncio.CancelledError:
            raise
        except BaseException as error:
            await self.fail(context, error)
        finally:
            if grant is not None and not completed:
                try:
                    await asyncio.shield(self.driver.end_tx(grant, "stream_interrupted", fencing))
                except DriverError:
                    pass
            if grant is not None:
                self._push_streams.discard(grant)

    async def EndTransmission(self, request, context):
        async def action():
            self.driver._check_radio(request.radio_id, request.generation)
            return tx_message(await self.driver.end_tx(request.tx_grant_id, "released:" + request.reason, request.fencing))
        return await self.unary(context, action)

    async def RenewTransmission(self, request, context):
        async def action():
            self.driver._check_radio(request.radio_id, request.generation)
            return tx_message(await self.driver.renew_tx(request.tx_grant_id, request.expires_at_utc, request.fencing))
        return await self.unary(context, action)

    async def ObserveTransmission(self, request, context):
        async def action():
            self.driver._check_radio(request.radio_id, request.generation)
            return tx_message(self.driver.observe_tx(request.tx_grant_id))
        return await self.unary(context, action)
