import asyncio
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, Mock, patch

from vgc_benlink.rfcomm_control import ManagedRfcommClient, discover_serial_channel, new_serial_connection, serial_channel


def record(channel, service="0x1101"):
    return f'''<record><attribute id="0x0001"><sequence><uuid value="{service}"/></sequence></attribute>
    <attribute id="0x0004"><sequence><sequence><uuid value="0x0100"/></sequence>
    <sequence><uuid value="0x0003"/><uint8 value="{hex(channel)}"/></sequence></sequence></attribute></record>'''.encode()


class RfcommTests(unittest.IsolatedAsyncioTestCase):
    def test_current_sdp_service_is_used_instead_of_old_cached_channel(self):
        self.assertEqual(serial_channel(b"Searching for SP ...\n" + record(1), 2), 1)
        self.assertEqual(serial_channel(record(3, "0x111f") + record(4), 2), 4)
        for response in (b"", record(2), record(0), record(31), record(1) + record(4), record(1, "0x111f")):
            with self.subTest(response=response), self.assertRaises(ConnectionError):
                serial_channel(response, 2)

    async def test_discovery_is_limited_to_configured_mac_and_reaps_oversized_response(self):
        process = SimpleNamespace(stdout=SimpleNamespace(read=AsyncMock(return_value=b"x" * 4096)), returncode=None)
        process.kill = Mock(side_effect=lambda: setattr(process, "returncode", -9))
        process.wait = AsyncMock(return_value=-9)
        with patch("vgc_benlink.rfcomm_control.sys.platform", "linux"), patch(
            "vgc_benlink.rfcomm_control.asyncio.create_subprocess_exec", AsyncMock(return_value=process)
        ) as start:
            with self.assertRaises(ConnectionError):
                await discover_serial_channel("AA:BB:CC:DD:EE:FF", 2)
        self.assertEqual(start.call_args.args, ("sdptool", "search", "--xml", "--bdaddr", "AA:BB:CC:DD:EE:FF", "SP"))
        process.kill.assert_called_once()
        process.wait.assert_awaited_once()

    async def test_invalid_discovery_address_never_starts_a_process(self):
        with patch("vgc_benlink.rfcomm_control.asyncio.create_subprocess_exec", AsyncMock()) as start:
            with self.assertRaises(ConnectionError):
                await discover_serial_channel("--other-device", 2)
        start.assert_not_awaited()

    def fixture(self, receive):
        handle = Mock()
        loop = SimpleNamespace(sock_connect=AsyncMock(), sock_recv=receive, sock_sendall=AsyncMock())
        socket_module = SimpleNamespace(socket=Mock(return_value=handle), AF_BLUETOOTH=31, SOCK_STREAM=1, BTPROTO_RFCOMM=3)
        return handle, loop, socket_module

    async def test_failed_open_closes_socket_before_returning(self):
        handle, loop, sockets = self.fixture(AsyncMock())
        loop.sock_connect.side_effect = ConnectionRefusedError()
        client = ManagedRfcommClient("fixture", 1)
        with patch("vgc_benlink.rfcomm_control.socket", sockets), patch("vgc_benlink.rfcomm_control.asyncio.get_running_loop", return_value=loop):
            with self.assertRaises(ConnectionRefusedError):
                await client.connect(Mock())
        handle.close.assert_called_once()
        self.assertFalse(client.is_connected())

    async def test_eof_or_parser_failure_closes_and_allows_clean_reopen(self):
        for chunks, callback in (([b""], Mock()), ([b"broken"], Mock(side_effect=ValueError("malformed frame")))):
            with self.subTest(chunks=chunks):
                handle, loop, sockets = self.fixture(AsyncMock(side_effect=chunks))
                client = ManagedRfcommClient("fixture", 1)
                with patch("vgc_benlink.rfcomm_control.socket", sockets), patch("vgc_benlink.rfcomm_control.asyncio.get_running_loop", return_value=loop):
                    await client.connect(callback)
                    await asyncio.gather(client.reader, return_exceptions=True)
                    self.assertFalse(client.is_connected())
                    handle.close.assert_called_once()
                    await client.disconnect()
                    await client.disconnect()
                    loop.sock_recv = AsyncMock(side_effect=[b""])
                    await client.connect(Mock())
                    await asyncio.gather(client.reader, return_exceptions=True)
                    await client.disconnect()
                self.assertEqual(loop.sock_connect.await_count, 2)

    async def test_disconnect_cancels_reader_and_closes_socket_even_after_error(self):
        started = asyncio.Event()
        async def receive(*args):
            started.set()
            await asyncio.Future()
        handle, loop, sockets = self.fixture(receive)
        client = ManagedRfcommClient("fixture", 1)
        with patch("vgc_benlink.rfcomm_control.socket", sockets), patch("vgc_benlink.rfcomm_control.asyncio.get_running_loop", return_value=loop):
            await client.connect(Mock())
            await started.wait()
            self.assertTrue(client.is_connected())
            await client.disconnect()
        self.assertFalse(client.is_connected())
        self.assertTrue(handle.close.called)

    def test_connection_retains_pinned_benlink_command_and_frame_implementation(self):
        from benlink.command import CommandConnection
        from benlink.link import RfcommCommandLink
        connection = new_serial_connection("fixture", 1)
        self.assertIsInstance(connection, CommandConnection)
        self.assertIsInstance(connection._link, RfcommCommandLink)
        self.assertIsInstance(connection._link._client, ManagedRfcommClient)
