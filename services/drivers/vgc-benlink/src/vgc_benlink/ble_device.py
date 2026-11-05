"""Resolve only the configured BlueZ device, including when it is not advertising."""
import asyncio
import re
import sys


async def cached_bluez_properties(path: str):
    from dbus_fast import BusType, Message, MessageType
    from dbus_fast.aio import MessageBus

    bus = MessageBus(bus_type=BusType.SYSTEM)
    try:
        await asyncio.wait_for(bus.connect(), 3)
        reply = await asyncio.wait_for(bus.call(Message(
            destination="org.bluez", path=path,
            interface="org.freedesktop.DBus.Properties", member="GetAll",
            signature="s", body=["org.bluez.Device1"],
        )), 3)
        if reply.message_type == MessageType.ERROR:
            if reply.error_name in {
                "org.freedesktop.DBus.Error.UnknownObject",
                "org.freedesktop.DBus.Error.UnknownMethod",
            }:
                return None
            raise ConnectionError("BlueZ could not read the configured device: " + reply.error_name)
        return {key: value.value for key, value in reply.body[0].items()}
    finally:
        bus.disconnect()


async def resolve_ble_device(address: str):
    # macOS uses CoreBluetooth UUIDs; other platforms retain benlink's lookup.
    if sys.platform != "linux" or not re.fullmatch(r"(?:[0-9a-fA-F]{2}:){5}[0-9a-fA-F]{2}", address):
        return address
    from bleak.backends.device import BLEDevice

    path = "/org/bluez/hci0/dev_" + address.upper().replace(":", "_")
    properties = await cached_bluez_properties(path)
    if properties is None:
        return address
    if properties.get("Address", "").upper() != address.upper():
        raise ConnectionError("BlueZ returned a different device than the configured address.")
    # Bleak's documented BLEDevice input avoids a new advertisement scan, which
    # cannot find a radio that BlueZ already connected. It also preserves the
    # configured device's D-Bus path for Bleak's normal connection lifecycle.
    return BLEDevice(address, properties.get("Name"), {"path": path, "props": properties})
