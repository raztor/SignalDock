from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, Mock, patch

from vgc_benlink.ble_device import cached_bluez_properties, resolve_ble_device


ADDRESS = "AA:BB:CC:DD:EE:FF"
PATH = "/org/bluez/hci0/dev_AA_BB_CC_DD_EE_FF"


class BleDeviceTests(unittest.IsolatedAsyncioTestCase):
    async def test_connected_radio_uses_cached_device_without_an_advertisement(self):
        properties = {"Address": ADDRESS, "Name": "Fixture", "Connected": True}
        with patch("vgc_benlink.ble_device.sys.platform", "linux"), patch(
            "vgc_benlink.ble_device.cached_bluez_properties", AsyncMock(return_value=properties)
        ) as read:
            device = await resolve_ble_device(ADDRESS.lower())
        read.assert_awaited_once_with(PATH)
        self.assertEqual(device.address.upper(), ADDRESS)
        self.assertEqual(device.details, {"path": PATH, "props": properties})

    async def test_undiscovered_device_retains_normal_benlink_discovery(self):
        with patch("vgc_benlink.ble_device.sys.platform", "linux"), patch(
            "vgc_benlink.ble_device.cached_bluez_properties", AsyncMock(return_value=None)
        ):
            self.assertEqual(await resolve_ble_device(ADDRESS), ADDRESS)

    async def test_corebluetooth_uuid_does_not_access_bluez(self):
        with patch("vgc_benlink.ble_device.sys.platform", "darwin"), patch(
            "vgc_benlink.ble_device.cached_bluez_properties", AsyncMock()
        ) as read:
            self.assertEqual(await resolve_ble_device("fixture-corebluetooth-uuid"), "fixture-corebluetooth-uuid")
        read.assert_not_awaited()

    async def test_wrong_cached_address_is_rejected(self):
        with patch("vgc_benlink.ble_device.sys.platform", "linux"), patch(
            "vgc_benlink.ble_device.cached_bluez_properties", AsyncMock(return_value={"Address": "11:22:33:44:55:66"})
        ):
            with self.assertRaises(ConnectionError):
                await resolve_ble_device(ADDRESS)

    @unittest.skipUnless(__import__("sys").platform == "linux", "BlueZ is Linux-only")
    async def test_unknown_object_falls_back_and_closes_bus(self):
        from dbus_fast import MessageType
        for error in ("UnknownObject", "UnknownMethod"):
            with self.subTest(error=error):
                bus = SimpleNamespace(connect=AsyncMock(), call=AsyncMock(return_value=SimpleNamespace(
                    message_type=MessageType.ERROR, error_name="org.freedesktop.DBus.Error." + error
                )), disconnect=Mock())
                with patch("dbus_fast.aio.MessageBus", return_value=bus):
                    self.assertIsNone(await cached_bluez_properties(PATH))
                bus.disconnect.assert_called_once()

    @unittest.skipUnless(__import__("sys").platform == "linux", "BlueZ is Linux-only")
    async def test_dbus_failure_is_not_hidden_as_absent_radio(self):
        from dbus_fast import MessageType
        bus = SimpleNamespace(connect=AsyncMock(), call=AsyncMock(return_value=SimpleNamespace(
            message_type=MessageType.ERROR, error_name="org.freedesktop.DBus.Error.AccessDenied"
        )), disconnect=Mock())
        with patch("dbus_fast.aio.MessageBus", return_value=bus):
            with self.assertRaisesRegex(ConnectionError, "AccessDenied"):
                await cached_bluez_properties(PATH)
        bus.disconnect.assert_called_once()
