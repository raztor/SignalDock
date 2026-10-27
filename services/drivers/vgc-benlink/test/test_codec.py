import math
import shutil
import struct
import unittest

from vgc_benlink.codec import FfmpegCodec, audio_data, sbc_frame_length
from vgc_benlink.model import DriverError


@unittest.skipUnless(shutil.which("ffmpeg"), "FFmpeg is required for real codec validation")
class CodecTests(unittest.IsolatedAsyncioTestCase):
    async def test_synthetic_pcm_encodes_and_decodes_through_real_streaming_pipes(self):
        sbc = []
        pcm = []
        endings = []
        async def encoded(value, samples): sbc.append((value, samples))
        async def decoded(value, end):
            if end: endings.append(True)
            else: pcm.append(value)
        codec = FfmpegCodec("ffmpeg", decoded, encoded)
        samples = [round(8000 * math.sin(2 * math.pi * 440 * index / 32000)) for index in range(6400)]
        source = struct.pack("<6400h", *samples)
        try:
            for offset in range(0, len(source), 1280):
                await codec.write_pcm(source[offset:offset + 1280])
            await codec.finish_encoder()
            self.assertTrue(sbc)
            for payload, count in sbc:
                self.assertLessEqual(count, 640)
                self.assertEqual(payload[1:3], bytes((0x71, 16)))
                self.assertEqual(len(payload), count // 128 * 40)
                self.assertGreaterEqual(sbc_frame_length(payload[:4]), 4)
                await codec.receive(audio_data(payload))
            await codec.end_burst()
            output = b"".join(pcm)
            self.assertLessEqual(abs(len(output) - len(source)), 256)
            self.assertGreater(max(abs(value) for value in struct.unpack(f"<{len(output)//2}h", output)), 1000)
            self.assertEqual(endings, [True])
        finally:
            await codec.close()

    async def test_unbounded_protocol_input_is_rejected(self):
        async def ignore(*args): pass
        codec = FfmpegCodec("ffmpeg", ignore, ignore)
        with self.assertRaises(DriverError):
            await codec.receive(bytes(65537))


if __name__ == "__main__": unittest.main()
