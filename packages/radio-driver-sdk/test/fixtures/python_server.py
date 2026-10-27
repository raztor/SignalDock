"""Synthetic gRPC conformance server; never accesses hardware."""
from concurrent import futures
import json
import os
import sys
import time
import uuid

import grpc
from signaldock.driver.v1 import driver_pb2 as pb
from signaldock.driver.v1 import driver_pb2_grpc as rpc

RADIO_ID = "00000000-0000-4000-8000-000000000001"


class FixtureDriver(rpc.RadioDriverServiceServicer):
    def __init__(self):
        self.generation = str(uuid.uuid4())
        self.revision = 1
        self.rx_hz = 145500000

    def check(self, context):
        metadata = dict(context.invocation_metadata())
        if metadata.get("authorization") != "Bearer fixture-token":
            context.abort(grpc.StatusCode.UNAUTHENTICATED,
                          json.dumps({"code": "UNAUTHORIZED", "message": "Private driver authentication failed."}))

    def snapshot(self):
        return pb.RadioSnapshot(radio_id=RADIO_ID, generation=self.generation,
                                revision=self.revision, connection="ready", tuning_confidence="confirmed",
                                observed_tuning=pb.Tuning(rx_hz=self.rx_hz, mode="FM"), tx_state="idle")

    def Describe(self, request, context):
        self.check(context)
        time.sleep(0.05)
        return pb.DescribeResponse(driver_id="fixture.grpc", version="0.1.0", protocol_min=1,
                                   protocol_max=1, capabilities=pb.RadioCapabilities(
                                       tuning_writable=True, tuning_ranges=[pb.FrequencyRange(min_hz=144000000, max_hz=148000000)],
                                       modes=["FM"], ptt_mechanism="unsupported", verification="simulated",
                                       independently_receivable_channels=1))

    def Connect(self, request, context):
        self.check(context)
        time.sleep(0.05)
        return self.snapshot()

    def GetSnapshot(self, request, context):
        self.check(context)
        return self.snapshot()

    def Reconcile(self, request, context):
        time.sleep(0.05)
        return self.GetSnapshot(request, context)

    def Disconnect(self, request, context):
        self.check(context)
        time.sleep(0.05)
        return pb.DisconnectResponse()

    def ApplyTuning(self, request, context):
        self.check(context)
        if request.context.generation != self.generation:
            context.abort(grpc.StatusCode.FAILED_PRECONDITION,
                          json.dumps({"code": "STALE_GENERATION", "message": "Driver generation changed."}))
        if request.context.expected_revision != self.revision:
            context.abort(grpc.StatusCode.FAILED_PRECONDITION,
                          json.dumps({"code": "STALE_REVISION", "message": "Driver revision changed."}))
        self.rx_hz = request.tuning.rx_hz
        self.revision += 1
        return self.snapshot()

    def WatchEvents(self, request, context):
        self.check(context)
        yield pb.RadioEvent(protocol_version=1, event_id=str(uuid.uuid4()), radio_id=RADIO_ID,
                            generation=self.generation, sequence=1,
                            occurred_at_utc="2026-10-26T12:00:00Z", snapshot=self.snapshot())

    def OpenRxStream(self, request, context):
        self.check(context)
        for sequence in range(3):
            yield pb.AudioFrame(stream_id=request.stream_id, sequence=sequence,
                                media_time_us=sequence * 20000,
                                format=pb.AudioFormat(sample_rate_hz=32000, channels=1, encoding="pcm_s16le"),
                                payload=bytes([0, 128, 255, 64]), tuning_revision=self.revision,
                                attribution_confidence="confirmed")


server = grpc.server(futures.ThreadPoolExecutor(max_workers=2), options=[
    ("grpc.max_receive_message_length", 1048576), ("grpc.max_send_message_length", 1048576)])
rpc.add_RadioDriverServiceServicer_to_server(FixtureDriver(), server)
port = server.add_insecure_port("127.0.0.1:0")
server.start()
print(json.dumps({"endpoint": f"127.0.0.1:{port}"}), flush=True)
server.wait_for_termination()
