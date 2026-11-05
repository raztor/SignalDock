"""Fresh SDP selection and bounded socket ownership for benlink serial control."""
import asyncio
import re
import socket
import sys
import xml.etree.ElementTree as ET

from benlink.command import CommandConnection
from benlink.link import RfcommCommandLink


def serial_channel(output: bytes, audio_channel: int) -> int:
    channels = set()
    for record in re.findall(rb"<record>.*?</record>", output, re.S):
        root = ET.fromstring(record)
        classes = root.find("attribute[@id='0x0001']")
        if classes is None or not any(node.get("value", "").lower() in {
            "0x1101", "00001101-0000-1000-8000-00805f9b34fb"
        } for node in classes.iter("uuid")):
            continue
        protocols = root.find("attribute[@id='0x0004']")
        if protocols is None:
            continue
        for sequence in protocols.iter("sequence"):
            children = list(sequence)
            if len(children) == 2 and children[0].tag == "uuid" and children[0].get("value", "").lower() == "0x0003":
                if children[1].tag != "uint8":
                    raise ConnectionError("The configured radio advertised an invalid serial channel.")
                channel = int(children[1].get("value", ""), 0)
                if not 1 <= channel <= 30 or channel == audio_channel:
                    raise ConnectionError("The radio's serial control channel conflicts with audio or is invalid.")
                channels.add(channel)
    if len(channels) != 1:
        raise ConnectionError("The configured radio must advertise exactly one serial control channel.")
    return channels.pop()


async def discover_serial_channel(address: str, audio_channel: int) -> int:
    if sys.platform != "linux" or not re.fullmatch(r"(?:[0-9a-fA-F]{2}:){5}[0-9a-fA-F]{2}", address):
        raise ConnectionError("Automatic serial channel selection requires a configured Linux Bluetooth MAC.")
    process = await asyncio.create_subprocess_exec(
        "sdptool", "search", "--xml", "--bdaddr", address, "SP",
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
    )

    async def read():
        output = bytearray()
        while chunk := await process.stdout.read(4096):
            output.extend(chunk)
            if len(output) > 65536:
                raise ConnectionError("The radio's SDP response exceeded its bound.")
        await process.wait()
        if process.returncode != 0:
            raise ConnectionError("Could not discover the configured radio's serial control service.")
        return bytes(output)

    try:
        return serial_channel(await asyncio.wait_for(read(), 8), audio_channel)
    finally:
        if process.returncode is None:
            process.kill()
        await process.wait()


class ManagedRfcommClient:
    """Close on EOF, parser failure, cancellation and failed opening alike.

    The pinned benlink client's reader can exit while retaining a live socket,
    and its disconnect can raise before closing that socket. Keep its framing
    unchanged and give the adapter explicit ownership of this transport instead.
    """

    def __init__(self, address: str, channel: int):
        self.address, self.channel = address, channel
        self.socket = None
        self.reader = None

    def is_connected(self):
        return self.socket is not None and self.reader is not None and not self.reader.done()

    async def connect(self, callback):
        if self.is_connected():
            raise RuntimeError("Already connected")
        await self.disconnect()
        handle = socket.socket(socket.AF_BLUETOOTH, socket.SOCK_STREAM, socket.BTPROTO_RFCOMM)
        handle.setblocking(False)
        try:
            await asyncio.get_running_loop().sock_connect(handle, (self.address, self.channel))
        except BaseException:
            handle.close()
            raise
        self.socket = handle

        async def listen():
            try:
                while data := await asyncio.get_running_loop().sock_recv(handle, 1024):
                    callback(data)
            finally:
                handle.close()
                if self.socket is handle:
                    self.socket = None

        self.reader = asyncio.create_task(listen())
        # A lost link is observed by the bounded status reads. Consume its task
        # exception now so a failure cannot become an unobserved background task.
        self.reader.add_done_callback(lambda task: None if task.cancelled() else task.exception())

    async def write(self, data):
        if not self.is_connected():
            raise ConnectionError("The radio's serial control link is closed.")
        await asyncio.get_running_loop().sock_sendall(self.socket, data)

    async def disconnect(self):
        handle, reader = self.socket, self.reader
        self.socket = self.reader = None
        try:
            if reader is not None:
                reader.cancel()
                await asyncio.gather(reader, return_exceptions=True)
        finally:
            if handle is not None:
                handle.close()


def new_serial_connection(address: str, channel: int):
    link = RfcommCommandLink(address, channel=channel)
    # This one compatibility seam is covered by tests against the pinned
    # dependency. All vendor frame parsing and commands remain in benlink.
    link._client = ManagedRfcommClient(address, channel)
    return CommandConnection(link)
