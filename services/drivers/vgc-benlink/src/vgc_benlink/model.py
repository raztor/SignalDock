"""Normalized driver values, independent of Bluetooth and gRPC."""
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Literal
import uuid
import math


class DriverError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def utc_epoch(value: str) -> float:
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            raise ValueError("Missing timezone")
        return parsed.timestamp()
    except (ValueError, TypeError):
        raise DriverError("INVALID_ARGUMENT", "A valid UTC deadline is required.") from None


@dataclass(frozen=True)
class DriverConfig:
    radio_id: str
    ble_address: str
    classic_address: str
    audio_channel: int = 2
    working_memory: int | None = None
    allow_experimental_tx: bool = False
    max_tx_seconds: float = 30.0
    idle_tx_seconds: float = 1.5
    audio_open_timeout: float = 10.0
    drain_seconds: float = 1.5
    ffmpeg: str = "ffmpeg"

    def __post_init__(self):
        if not all(isinstance(value, str) and value for value in (self.radio_id, self.ble_address, self.classic_address, self.ffmpeg)):
            raise DriverError("INVALID_ARGUMENT", "Radio addresses, ID, and executable must be nonempty strings.")
        try:
            uuid.UUID(self.radio_id)
        except ValueError:
            raise DriverError("INVALID_ARGUMENT", "radio_id must be a UUID.") from None
        if not self.ble_address or not self.classic_address:
            raise DriverError("INVALID_ARGUMENT", "Explicit BLE and Classic addresses are required.")
        if type(self.audio_channel) is not int or not 1 <= self.audio_channel <= 30:
            raise DriverError("INVALID_ARGUMENT", "audio_channel must be in 1..30.")
        if self.working_memory is not None and (type(self.working_memory) is not int or not 0 <= self.working_memory <= 255):
            raise DriverError("INVALID_ARGUMENT", "working_memory must be in 0..255.")
        if type(self.allow_experimental_tx) is not bool:
            raise DriverError("INVALID_ARGUMENT", "allow_experimental_tx must be a boolean.")
        for value in (self.idle_tx_seconds, self.max_tx_seconds, self.audio_open_timeout, self.drain_seconds):
            if type(value) not in (float, int) or not math.isfinite(value):
                raise DriverError("INVALID_ARGUMENT", "Driver time limits must be finite numbers.")
        if not 0 < self.idle_tx_seconds <= 1.5 or not 0 < self.max_tx_seconds <= 30:
            raise DriverError("INVALID_ARGUMENT", "TX limits exceed the driver bounds.")
        if not 0 < self.audio_open_timeout <= 15 or not 0 <= self.drain_seconds <= 3:
            raise DriverError("INVALID_ARGUMENT", "Audio time limits exceed the driver bounds.")


@dataclass(frozen=True)
class Operation:
    operation_id: str
    radio_id: str
    generation: str
    expected_revision: int
    deadline_utc: str
    control_grant: str
    fencing: int = 0
    owner_id: str = ""
    session_id: str = ""


@dataclass(frozen=True)
class Tuning:
    rx_hz: int
    tx_hz: int | None = None
    mode: str = "FM"

    def validate(self):
        for value in [self.rx_hz, self.tx_hz]:
            if value is None:
                continue
            if isinstance(value, bool) or not isinstance(value, int) or not (136_000_000 <= value <= 174_000_000 or 400_000_000 <= value <= 470_000_000):
                raise DriverError("CAPABILITY_UNSUPPORTED", "Frequency is outside the VGC FM capability.")
        if self.mode != "FM":
            raise DriverError("CAPABILITY_UNSUPPORTED", "The initial VGC adapter supports FM only.")


@dataclass
class Snapshot:
    radio_id: str
    generation: str = field(default_factory=lambda: str(uuid.uuid4()))
    revision: int = 0
    connection: str = "disconnected"
    observed_tuning: Tuning | None = None
    desired_tuning: Tuning | None = None
    tuning_confidence: str = "unknown"
    tx_state: str = "idle"
    selected_memory_id: str | None = None


@dataclass(frozen=True)
class Memory:
    memory_id: str
    name: str
    tuning: Tuning


@dataclass(frozen=True)
class PcmFrame:
    stream_id: str
    sequence: int
    media_time_us: int
    payload: bytes
    tuning_revision: int
    attribution_confidence: str = "unknown"
    discontinuity: bool = False
    sample_rate_hz: int = 32_000
    channels: int = 1
    encoding: str = "pcm_s16le"
    end_of_burst: bool = False

    def validate(self):
        if (self.encoding, self.sample_rate_hz, self.channels) != ("pcm_s16le", 32_000, 1):
            raise DriverError("CAPABILITY_UNSUPPORTED", "VGC PCM must be mono s16le at 32000Hz.")
        if not self.payload or len(self.payload) > 1280 or len(self.payload) % 2:
            raise DriverError("INVALID_ARGUMENT", "PCM frames must contain 1..640 complete samples.")


@dataclass(frozen=True)
class TxObservation:
    radio_id: str
    generation: str
    tx_grant_id: str
    state: str
    physically_confirmed: bool
