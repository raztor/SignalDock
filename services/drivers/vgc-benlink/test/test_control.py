import copy
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest

from vgc_benlink.control import BenlinkControl
from vgc_benlink.model import DriverConfig, DriverError, Tuning
from vgc_benlink.recovery import RecoveryJournal
from test_adapter import RADIO


class Record:
    def __init__(self, **data):
        self.__dict__.update(data)

    def model_copy(self, update):
        return Record(**(self.model_dump() | update))

    def model_dump(self, mode="json"):
        return copy.deepcopy(self.__dict__)

    def to_protocol(self):
        return SimpleNamespace(to_bytes=lambda: bytes(1))


class Connection:
    def __init__(self):
        self.connected = False
        self.channel = Record(channel_id=9, name="Fixture", rx_freq=147.54, tx_freq=147.54, rx_mod="FM", tx_mod="FM",
            fixed_freq=False, tx_disable=False, tx_sub_audio=23, tx_at_max_power=True, tx_at_med_power=False)
        self.settings = Record(channel_a=9, channel_b=3, double_channel=0, scan=False, ptt_lock=False)
        self.fail_writes = 0
        self.write_calls = 0

    async def connect(self): self.connected = True
    async def disconnect(self): self.connected = False
    def is_connected(self): return self.connected
    async def get_device_info(self): return SimpleNamespace(vendor_id=1, product_id=8, channel_count=32)
    async def get_status(self): return SimpleNamespace(curr_region=0, curr_ch_id=31, is_in_tx=False)
    async def get_settings(self): return self.settings
    async def get_channel(self, index): return self.channel
    async def set_settings(self, value): self.settings = value

    async def set_channel(self, value):
        self.channel = value
        self.write_calls += 1
        if self.fail_writes:
            self.fail_writes -= 1
            raise TimeoutError("Fixture accepted a write but lost its reply.")


class ControlTests(unittest.IsolatedAsyncioTestCase):
    async def test_tuning_uses_selection_readback_and_preserves_unrelated_memory_fields(self):
        connection = Connection()
        control = BenlinkControl(DriverConfig(RADIO, "ble", "classic", working_memory=9), connection)
        before = connection.channel.model_dump()
        self.assertEqual((await control.connect()).confidence, "unknown")
        result = await control.tune(Tuning(147552500))
        self.assertEqual(result.tuning.rx_hz, 147552500)
        self.assertEqual(result.confidence, "confirmed")
        self.assertEqual(result.memory_id, 9)
        for key in set(before) - {"rx_freq", "rx_mod"}:
            self.assertEqual(getattr(connection.channel, key), before[key])
        self.assertEqual(connection.settings.channel_a, connection.settings.channel_b)

    async def test_timed_out_applied_write_is_restored_and_journalled_before_returning(self):
        with tempfile.TemporaryDirectory(prefix="vgc-recovery-") as directory:
            connection = Connection()
            control = BenlinkControl(DriverConfig(RADIO, "ble", "classic", working_memory=9), connection, Path(directory))
            before = connection.channel.model_dump()
            settings = connection.settings.model_dump()
            await control.connect()
            connection.fail_writes = 1
            with self.assertRaises(TimeoutError):
                await control.tune(Tuning(147552500))
            self.assertEqual(connection.channel.model_dump(), before)
            self.assertEqual(connection.settings.model_dump(), settings)
            self.assertFalse((Path(directory) / "pending.json").exists())
            self.assertTrue((Path(directory) / "last-operation.json").exists())

    async def test_unconfirmed_restoration_retains_private_recovery_and_blocks_tx(self):
        with tempfile.TemporaryDirectory(prefix="vgc-recovery-") as directory:
            connection = Connection()
            control = BenlinkControl(DriverConfig(RADIO, "ble", "classic", working_memory=9), connection, Path(directory))
            await control.connect()
            connection.fail_writes = 2
            with self.assertRaises(DriverError) as failed:
                await control.tune(Tuning(147552500))
            self.assertEqual(failed.exception.code, "RADIO_STATE_UNCERTAIN")
            pending = Path(directory) / "pending.json"
            self.assertTrue(pending.exists())
            self.assertEqual(pending.stat().st_mode & 0o777, 0o600)
            with self.assertRaises(DriverError):
                await control.tx_ready()

    async def test_empty_memories_are_filtered_and_cannot_be_selected(self):
        connection = Connection()
        control = BenlinkControl(DriverConfig(RADIO, "ble", "classic"), connection)
        await control.connect()
        programmed = connection.channel
        empty = programmed.model_copy(update={"channel_id": 0, "rx_freq": 0, "tx_freq": 0, "name": ""})
        async def get_channel(index):
            return programmed if index == 9 else empty.model_copy(update={"channel_id": index})
        connection.get_channel = get_channel
        self.assertEqual([memory.memory_id for memory in await control.list_memories()], ["9"])
        before = connection.settings.model_dump()
        with self.assertRaises(DriverError) as read:
            await control.read_memory("0")
        self.assertEqual(read.exception.code, "NOT_FOUND")
        with self.assertRaises(DriverError) as selection:
            await control.select_memory("0")
        self.assertEqual(selection.exception.code, "NOT_FOUND")
        self.assertEqual(connection.settings.model_dump(), before)
        self.assertEqual(connection.write_calls, 0)

    async def test_receive_only_memory_omits_zero_transmit_frequency(self):
        connection = Connection()
        control = BenlinkControl(DriverConfig(RADIO, "ble", "classic"), connection)
        await control.connect()
        connection.channel = connection.channel.model_copy(update={"tx_freq": 0, "tx_disable": True})
        memory = await control.read_memory("9")
        self.assertEqual(memory.tuning.rx_hz, 147540000)
        self.assertIsNone(memory.tuning.tx_hz)

    async def test_memory_read_failure_does_not_look_like_an_empty_list(self):
        connection = Connection()
        control = BenlinkControl(DriverConfig(RADIO, "ble", "classic"), connection)
        await control.connect()
        async def fail_read(index):
            raise ConnectionError("Fixture memory read failed.")
        connection.get_channel = fail_read
        with self.assertRaises(ConnectionError):
            await control.list_memories()

    async def test_selected_unprogrammed_memory_has_unknown_tuning_and_blocks_tx(self):
        connection = Connection()
        connection.settings = connection.settings.model_copy(update={"channel_a": 9, "channel_b": 9})
        connection.channel = connection.channel.model_copy(update={"rx_freq": 0, "tx_freq": 0})
        control = BenlinkControl(DriverConfig(RADIO, "ble", "classic"), connection)
        observed = await control.connect()
        self.assertIsNone(observed.tuning)
        self.assertEqual(observed.confidence, "unknown")
        with self.assertRaises(DriverError) as unsafe:
            await control.tx_ready()
        self.assertEqual(unsafe.exception.code, "RADIO_STATE_UNCERTAIN")


if __name__ == "__main__": unittest.main()
