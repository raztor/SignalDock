"""Private durable recovery snapshots, saved before the first device write."""
import json
import os
from pathlib import Path

from .model import DriverError, utc_now


class RecoveryJournal:
    def __init__(self, directory: Path):
        self.directory = directory
        self.path = directory / "pending.json"

    def pending(self):
        return json.loads(self.path.read_text()) if self.path.exists() else None

    def require_clear(self):
        if self.path.exists():
            raise DriverError("RADIO_STATE_UNCERTAIN", "An unresolved recovery snapshot exists; review and recover it before further writes.")

    def begin(self, address: str, region: int, channel=None, settings=None):
        self.require_clear()
        self.directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        entry = {"kind": "signaldock-vgc-recovery", "startedUtc": utc_now(), "address": address, "region": region,
            "original_channel": channel.model_dump(mode="json") if channel is not None else None,
            "original_settings": settings.model_dump(mode="json") if settings is not None else None}
        temporary = self.path.with_suffix(".tmp")
        with open(temporary, "x", opener=lambda path, flags: os.open(path, flags, 0o600)) as output:
            output.write(json.dumps(entry, indent=2) + "\n")
            output.flush()
            os.fsync(output.fileno())
        temporary.replace(self.path)
        directory = os.open(self.directory, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)

    def complete(self):
        if self.path.exists():
            self.path.replace(self.directory / "last-operation.json")
