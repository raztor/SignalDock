"""Locate the separately generated private protocol bindings."""
import os
from pathlib import Path
import sys


def bindings():
    configured = os.environ.get("SIGNALDOCK_DRIVER_BINDINGS")
    candidates = [Path(configured)] if configured else [parent / "packages/radio-driver-sdk/generated/python" for parent in Path(__file__).resolve().parents]
    for candidate in candidates:
        if (candidate / "signaldock/driver/v1/driver_pb2.py").is_file():
            sys.path.insert(0, str(candidate))
            break
    try:
        from signaldock.driver.v1 import driver_pb2, driver_pb2_grpc
    except ImportError:
        raise RuntimeError("Generate the private driver bindings or set SIGNALDOCK_DRIVER_BINDINGS to their Python directory.") from None
    return driver_pb2, driver_pb2_grpc
