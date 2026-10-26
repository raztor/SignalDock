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


if __name__ == "__main__": unittest.main()
