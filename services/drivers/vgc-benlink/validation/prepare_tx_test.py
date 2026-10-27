"""Generate two test tones and benlink frames without connecting to the radio."""
import argparse
import base64
import json
import math
import struct
import subprocess
import wave

from benlink import protocol
from validation_paths import RESULTS_DIRECTORY


def main():
    argparse.ArgumentParser(description=__doc__).parse_args()
    folder = RESULTS_DIRECTORY
    folder.mkdir(exist_ok=True)
    wav_path = folder / "tx-two-tones.wav"
    sbc_path = folder / "tx-two-tones.sbc"
    with wave.open(str(wav_path), "wb") as output:
        output.setparams((1, 2, 32000, 0, "NONE", "not compressed"))
        samples = []
        for index in range(64000):
            t = index / 32000
            hz = 880 if 0.2 <= t < 0.8 else 1320 if 1.0 <= t < 1.6 else 0
            samples.append(round(8192 * math.sin(2 * math.pi * hz * t)) if hz else 0)
        output.writeframes(struct.pack("<64000h", *samples))
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(wav_path), "-c:a", "sbc",
                    "-global_quality", "1888", "-sbc_delay", "0.0075", "-f", "sbc", str(sbc_path)], check=True)
    probe = subprocess.run(["ffprobe", "-v", "error", "-f", "sbc", "-show_packets", "-show_entries",
                            "packet=pos,size,duration_time", "-of", "json", str(sbc_path)],
                           check=True, capture_output=True, text=True)
    packets = json.loads(probe.stdout)["packets"]
    if not packets or any(abs(float(packet["duration_time"]) - 0.004) > 1e-6 for packet in packets):
        raise RuntimeError("Expected 128-sample SBC frames at 32 kHz.")
    encoded = sbc_path.read_bytes()
    chunks = []
    for index in range(0, len(packets), 5):
        group = packets[index:index + 5]
        data = b"".join(encoded[int(p["pos"]):int(p["pos"]) + int(p["size"])] for p in group)
        chunks.append(base64.b64encode(protocol.audio_message_to_bytes(protocol.AudioData(data))).decode())
    if len(chunks) > 100:
        raise RuntimeError("The audio exceeds the two-second limit.")
    result = {"kind": "two-tone-test", "seconds": len(packets) * 0.004, "interval_seconds": 0.02,
              "chunks_base64": chunks,
              "end_base64": base64.b64encode(protocol.audio_message_to_bytes(protocol.AudioEnd())).decode()}
    path = folder / "tx-two-tones.job.json"
    path.write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps({"wav": str(wav_path), "job": str(path), "seconds": result["seconds"],
                      "chunks": len(chunks)}, indent=2))


if __name__ == "__main__":
    main()
