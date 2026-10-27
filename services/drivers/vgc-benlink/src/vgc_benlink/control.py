"""BLE control adapter. Device semantics remain inside the VGC module."""
from dataclasses import dataclass
from decimal import Decimal
from typing import Protocol
from pathlib import Path

from .model import DriverConfig, DriverError, Tuning, Memory
from .recovery import RecoveryJournal


@dataclass(frozen=True)
class ControlObservation:
    tuning: Tuning | None
    tx_active: bool | None
    confidence: str
    memory_id: int | None
    region: int


class ControlPort(Protocol):
    async def connect(self) -> ControlObservation: ...
    async def disconnect(self) -> None: ...
    async def observe(self) -> ControlObservation: ...
    async def tune(self, tuning: Tuning) -> ControlObservation: ...
    async def tx_ready(self) -> None: ...
    async def list_memories(self) -> list[Memory]: ...
    async def read_memory(self, memory_id: str) -> Memory: ...
    async def write_memory(self, memory: Memory) -> Memory: ...
    async def select_memory(self, memory_id: str) -> ControlObservation: ...


def hz(value: float) -> int:
    return int(Decimal(str(value)) * 1_000_000)


class BenlinkControl:
    def __init__(self, config: DriverConfig, connection=None, recovery_directory: Path | None = None):
        self.config = config
        self.connection = connection
        self._original_region: int | None = None
        self.memory_count = 0
        self.journal = RecoveryJournal(recovery_directory) if recovery_directory else None

    async def connect(self) -> ControlObservation:
        if self.connection is None:
            from benlink.command import CommandConnection
            self.connection = CommandConnection.new_ble(self.config.ble_address)
        await self.connection.connect()
        try:
            self._original_region = None
            info = await self.connection.get_device_info()
            if info.vendor_id != 1 or info.product_id != 8:
                raise DriverError("CAPABILITY_UNSUPPORTED", "This adapter is verified only for the VR-N7500 device family.")
            self.memory_count = min(info.channel_count, 256)
            if self.config.working_memory is not None and self.config.working_memory >= info.channel_count:
                raise DriverError("INVALID_ARGUMENT", "Configured working memory is outside the device memory count.")
            observed = await self.observe()
            self._original_region = observed.region
            return observed
        except BaseException:
            await self.disconnect()
            raise

    async def disconnect(self) -> None:
        if self.connection is not None and self.connection.is_connected():
            await self.connection.disconnect()

    async def observe(self) -> ControlObservation:
        status = await self.connection.get_status()
        if self._original_region is not None and status.curr_region != self._original_region:
            raise DriverError("RADIO_STATE_UNCERTAIN", "The region changed; reconnect and reconcile the configured radio.")
        settings = await self.connection.get_settings()
        # curr_ch_id is not authoritative on the validated VR-N7500.
        single = settings.channel_a == settings.channel_b and settings.double_channel == 0 and not settings.scan
        tuning = None
        memory_id = settings.channel_a if single else None
        if single:
            channel = await self.connection.get_channel(memory_id)
            try:
                tuning = self._memory(channel).tuning
            except DriverError as error:
                if error.code not in {"NOT_FOUND", "CAPABILITY_UNSUPPORTED"}:
                    raise
        return ControlObservation(tuning, status.is_in_tx, "confirmed" if tuning is not None else "unknown", memory_id, status.curr_region)

    async def tx_ready(self) -> None:
        if self.journal is not None:
            self.journal.require_clear()
        observed = await self.observe()
        if observed.tx_active:
            raise DriverError("CONTROL_BUSY", "The device is already transmitting.")
        if observed.confidence != "confirmed" or observed.memory_id is None:
            raise DriverError("RADIO_STATE_UNCERTAIN", "TX requires verified single-watch memory selection.")
        channel = await self.connection.get_channel(observed.memory_id)
        settings = await self.connection.get_settings()
        if channel.tx_disable or channel.tx_mod != "FM" or settings.ptt_lock:
            raise DriverError("CAPABILITY_UNSUPPORTED", "The current memory/settings do not allow FM transmission.")

    async def tune(self, tuning: Tuning) -> ControlObservation:
        tuning.validate()
        index = self.config.working_memory
        if index is None:
            raise DriverError("CAPABILITY_UNSUPPORTED", "An explicit working memory is required for memory-based tuning.")
        status = await self.connection.get_status()
        if status.is_in_tx:
            raise DriverError("CONTROL_BUSY", "Retuning during TX is not allowed.")
        original = await self.connection.get_channel(index)
        original_settings = await self.connection.get_settings()
        if original.fixed_freq:
            raise DriverError("CAPABILITY_UNSUPPORTED", "The selected working memory has fixed frequency.")
        if self._original_region is not None and status.curr_region != self._original_region:
            raise DriverError("RADIO_STATE_UNCERTAIN", "The device region changed externally.")
        updates = {"rx_freq": tuning.rx_hz / 1_000_000, "rx_mod": tuning.mode}
        if tuning.tx_hz is not None:
            updates.update(tx_freq=tuning.tx_hz / 1_000_000, tx_mod=tuning.mode)
        changed = original.model_copy(update=updates)
        selection = original_settings.model_copy(update={"channel_a": index, "channel_b": index, "double_channel": 0, "scan": False})
        changed.to_protocol().to_bytes()
        selection.to_protocol().to_bytes()
        self._begin_write(status.curr_region, original, original_settings)
        try:
            await self.connection.set_channel(changed)
            actual = await self.connection.get_channel(index)
            if actual.model_dump(mode="json") != changed.model_dump(mode="json"):
                raise DriverError("RADIO_STATE_UNCERTAIN", "Memory write readback did not match.")
            await self.connection.set_settings(selection)
            if (await self.connection.get_settings()).model_dump(mode="json") != selection.model_dump(mode="json"):
                raise DriverError("RADIO_STATE_UNCERTAIN", "Memory selection readback did not match.")
            observed = await self.observe()
            if observed.confidence != "confirmed" or observed.tuning is None or observed.tuning.rx_hz != tuning.rx_hz:
                raise DriverError("RADIO_STATE_UNCERTAIN", "Effective tuning was not confirmed.")
            self._complete_write()
            return observed
        except BaseException as cause:
            # A timed-out write may have reached the device. Restore both snapshots.
            try:
                state = await self.connection.get_status()
                if state.curr_region != status.curr_region or state.is_in_tx:
                    raise RuntimeError("Restoration is unsafe in the current region/TX state.")
                await self.connection.set_channel(original)
                await self.connection.set_settings(original_settings)
                if ((await self.connection.get_channel(index)).model_dump(mode="json") != original.model_dump(mode="json") or
                        (await self.connection.get_settings()).model_dump(mode="json") != original_settings.model_dump(mode="json")):
                    raise RuntimeError("Restoration readback did not match.")
                self._complete_write()
            except BaseException:
                raise DriverError("RADIO_STATE_UNCERTAIN", "Tuning failed and restoration is unconfirmed; reconcile the radio locally.") from cause
            raise

    def _memory_index(self, value: str) -> int:
        try:
            index = int(value)
        except (TypeError, ValueError):
            raise DriverError("INVALID_ARGUMENT", "Memory ID must be a canonical decimal index.") from None
        if str(index) != value or not 0 <= index < self.memory_count:
            raise DriverError("INVALID_ARGUMENT", "Memory ID is outside this device's memory count.")
        return index

    @staticmethod
    def _memory(channel) -> Memory:
        if channel.rx_freq == 0:
            raise DriverError("NOT_FOUND", "The memory slot is unprogrammed.")
        tuning = Tuning(hz(channel.rx_freq), hz(channel.tx_freq) if channel.tx_freq else None, channel.rx_mod)
        try:
            tuning.validate()
        except DriverError:
            raise DriverError("CAPABILITY_UNSUPPORTED", "This memory uses a frequency or mode outside the driver's declared capabilities.") from None
        return Memory(str(channel.channel_id), channel.name, tuning)

    async def list_memories(self) -> list[Memory]:
        memories = []
        for index in range(self.memory_count):
            try:
                memories.append(await self.read_memory(str(index)))
            except DriverError as error:
                if error.code not in {"NOT_FOUND", "CAPABILITY_UNSUPPORTED"}:
                    raise
        return memories

    async def read_memory(self, memory_id: str) -> Memory:
        return self._memory(await self.connection.get_channel(self._memory_index(memory_id)))

    async def write_memory(self, memory: Memory) -> Memory:
        memory.tuning.validate()
        index = self._memory_index(memory.memory_id)
        if len(memory.name.encode("utf8")) > 10:
            raise DriverError("INVALID_ARGUMENT", "VGC memory names are limited to ten encoded bytes.")
        status = await self.connection.get_status()
        if status.is_in_tx or status.curr_region != self._original_region:
            raise DriverError("RADIO_STATE_UNCERTAIN", "Memory writing is not valid in the current TX/region state.")
        original = await self.connection.get_channel(index)
        if original.fixed_freq:
            raise DriverError("CAPABILITY_UNSUPPORTED", "The memory has fixed frequency.")
        updates = {"name": memory.name, "rx_freq": memory.tuning.rx_hz / 1_000_000, "rx_mod": memory.tuning.mode}
        if memory.tuning.tx_hz is not None:
            updates.update(tx_freq=memory.tuning.tx_hz / 1_000_000, tx_mod=memory.tuning.mode)
        changed = original.model_copy(update=updates)
        changed.to_protocol().to_bytes()
        self._begin_write(status.curr_region, original)
        try:
            await self.connection.set_channel(changed)
            actual = await self.connection.get_channel(index)
            if actual.model_dump(mode="json") != changed.model_dump(mode="json"):
                raise DriverError("RADIO_STATE_UNCERTAIN", "Memory readback did not match.")
            self._complete_write()
            return self._memory(actual)
        except BaseException as cause:
            try:
                state = await self.connection.get_status()
                if state.is_in_tx or state.curr_region != status.curr_region:
                    raise RuntimeError("Restoration cannot be attempted in the new device state.")
                await self.connection.set_channel(original)
                if (await self.connection.get_channel(index)).model_dump(mode="json") != original.model_dump(mode="json"):
                    raise RuntimeError("Restoration readback did not match.")
                self._complete_write()
            except BaseException:
                raise DriverError("RADIO_STATE_UNCERTAIN", "Memory restoration is unconfirmed.") from cause
            raise

    async def select_memory(self, memory_id: str) -> ControlObservation:
        index = self._memory_index(memory_id)
        await self.read_memory(memory_id)
        status = await self.connection.get_status()
        if status.is_in_tx or status.curr_region != self._original_region:
            raise DriverError("RADIO_STATE_UNCERTAIN", "Memory selection is not valid in the current TX/region state.")
        original = await self.connection.get_settings()
        selected = original.model_copy(update={"channel_a": index, "channel_b": index, "double_channel": 0, "scan": False})
        selected.to_protocol().to_bytes()
        self._begin_write(status.curr_region, settings=original)
        try:
            await self.connection.set_settings(selected)
            if (await self.connection.get_settings()).model_dump(mode="json") != selected.model_dump(mode="json"):
                raise DriverError("RADIO_STATE_UNCERTAIN", "Selected memory was not confirmed.")
            observed = await self.observe()
            self._complete_write()
            return observed
        except BaseException as cause:
            try:
                state = await self.connection.get_status()
                if state.is_in_tx or state.curr_region != status.curr_region:
                    raise RuntimeError("Selection restoration is unsafe.")
                await self.connection.set_settings(original)
                if (await self.connection.get_settings()).model_dump(mode="json") != original.model_dump(mode="json"):
                    raise RuntimeError("Selection restoration was not verified.")
                self._complete_write()
            except BaseException:
                raise DriverError("RADIO_STATE_UNCERTAIN", "Selection restoration is unconfirmed.") from cause
            raise

    def _begin_write(self, region, channel=None, settings=None):
        if self.journal is not None:
            self.journal.begin(self.config.ble_address, region, channel, settings)

    def _complete_write(self):
        if self.journal is not None:
            self.journal.complete()

    async def recover_pending(self):
        if self.journal is None or self.journal.pending() is None:
            raise DriverError("NOT_FOUND", "There is no pending recovery snapshot.")
        from benlink.command import Channel, Settings
        recovery = self.journal.pending()
        if recovery["address"] != self.config.ble_address:
            raise DriverError("INVALID_ARGUMENT", "Recovery snapshot belongs to another radio.")
        await self.connect()
        try:
            status = await self.connection.get_status()
            if status.is_in_tx or status.curr_region != recovery["region"]:
                raise DriverError("RADIO_STATE_UNCERTAIN", "Restore requires the original region and physically idle TX.")
            if recovery["original_channel"] is not None:
                channel = Channel.model_validate(recovery["original_channel"])
                await self.connection.set_channel(channel)
                if (await self.connection.get_channel(channel.channel_id)).model_dump(mode="json") != channel.model_dump(mode="json"):
                    raise DriverError("RADIO_STATE_UNCERTAIN", "Recovered memory readback did not match.")
            if recovery["original_settings"] is not None:
                settings = Settings.model_validate(recovery["original_settings"])
                await self.connection.set_settings(settings)
                if (await self.connection.get_settings()).model_dump(mode="json") != settings.model_dump(mode="json"):
                    raise DriverError("RADIO_STATE_UNCERTAIN", "Recovered settings readback did not match.")
            self.journal.complete()
        finally:
            await self.disconnect()
