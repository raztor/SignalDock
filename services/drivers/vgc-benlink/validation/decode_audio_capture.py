"""Extract SBC audio from a native capture using the benlink protocol."""
import argparse
from array import array
import base64
import json
import math
from pathlib import Path
import shutil
import subprocess
import wave

from benlink import protocol


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("capture", type=Path)
    args = parser.parse_args()
    capture = json.loads(args.capture.read_text())
    buffer = b"".join(base64.b64decode(chunk, validate=True)
                      for chunk in capture.get("audio_chunks_base64", []))
    summary = {"capture": str(args.capture.resolve()), "native_result": capture["result"],
               "raw_bytes": len(buffer), "message_types": {}, "sbc_bytes": 0,
               "voice_confirmed_by_listener": False}
    sbc = bytearray()
    while buffer:
        message, buffer = protocol.next_audio_message(buffer)
        if message is None:
            break
        kind = type(message).__name__
        summary["message_types"][kind] = summary["message_types"].get(kind, 0) + 1
        if isinstance(message, protocol.AudioData):
            sbc.extend(message.sbc_data)
    summary["trailing_bytes"] = len(buffer)
    summary["sbc_bytes"] = len(sbc)
    summary["result"] = "no_sbc_audio"
    if sbc:
        sbc_path = args.capture.with_suffix(".sbc")
        sbc_path.write_bytes(sbc)
        summary["sbc_file"] = str(sbc_path.resolve())
        summary["result"] = "sbc_extracted"
        ffmpeg = shutil.which("ffmpeg")
        if ffmpeg:
            wav_path = args.capture.with_suffix(".wav")
            converted = subprocess.run([ffmpeg, "-v", "error", "-y", "-f", "sbc", "-i", str(sbc_path),
                                        "-ac", "1", "-ar", "32000", "-c:a", "pcm_s16le", str(wav_path)],
                                       capture_output=True, text=True)
            summary["ffmpeg_exit_code"] = converted.returncode
            if converted.returncode:
                summary.update(result="decode_failed", decoder_error=converted.stderr[-2000:])
            else:
                with wave.open(str(wav_path), "rb") as audio:
                    samples = array("h", audio.readframes(audio.getnframes()))
                    summary.update(wav_file=str(wav_path.resolve()), sample_rate=audio.getframerate(),
                                   seconds=audio.getnframes() / audio.getframerate(),
                                   peak=max((abs(sample) for sample in samples), default=0),
                                   rms=math.sqrt(sum(sample * sample for sample in samples) / len(samples)) if samples else 0,
                                   result="wav_decoded")
    destination = args.capture.with_suffix(".audio-analysis.json")
    destination.write_text(json.dumps(summary, indent=2, ensure_ascii=False) + "\n")
    print(json.dumps(summary, indent=2, ensure_ascii=False))
    return 0 if summary["result"] == "wav_decoded" else 2


if __name__ == "__main__":
    raise SystemExit(main())
