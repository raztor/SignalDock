"""Temporary RX-frequency change, readback, and memory restoration."""

import argparse
import asyncio
from datetime import datetime, timezone
from decimal import Decimal
import json
from pathlib import Path
import sys

from benlink.command import Channel, CommandConnection
from radio_probe import Report, positive
from validation_paths import RESULTS_DIRECTORY


def frequency(value):
    try:
        number = Decimal(value)
        if not number.is_finite() or number * 1_000_000 != (number * 1_000_000).to_integral_value():
            raise ValueError()
        if not (136 <= number <= 174 or 400 <= number <= 470):
            raise ValueError()
    except (ValueError, ArithmeticError):
        raise argparse.ArgumentTypeError("Frequency in MHz at 1 Hz resolution, within 136–174 or 400–470.")
    return float(number)


def parse_args():
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--rx-mhz", type=frequency)
    mode.add_argument("--restore-from", type=Path, help="Restore the snapshot saved in an earlier report")
    parser.add_argument("--address", help="BLE UUID; required with --rx-mhz")
    parser.add_argument("--channel", type=int, help="Explicit memory index to test")
    parser.add_argument("--hold", type=positive, default=3)
    parser.add_argument("--timeout", type=positive, default=15)
    parser.add_argument("--apply", action="store_true", help="Apply writes; otherwise only prepare the change")
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    if args.rx_mhz is not None and not args.address:
        parser.error("--rx-mhz requires --address")
    if args.rx_mhz is not None and args.channel is None:
        parser.error("--rx-mhz requires --channel: the reported status index is not always a reliable selection on this radio")
    if args.channel is not None and not 0 <= args.channel <= 255:
        parser.error("--channel must be between 0 and 255")
    if args.restore_from and (args.address or args.channel is not None):
        parser.error("--restore-from uses the address, region, and memory from the original report")
    return args


def verify_channel(actual, expected):
    if actual.model_dump(mode="json") != expected.model_dump(mode="json"):
        raise RuntimeError("Memory readback does not match the expected configuration.")


async def restore(conn, original, region, report, timeout):
    state = await report.step("status_before_restore", conn.get_status(), timeout)
    if state.curr_region != region:
        raise RuntimeError("The region changed externally; the snapshot is retained to avoid overwriting another region.")
    await report.step("restore_write", conn.set_channel(original), timeout)
    restored = await report.step("restore_readback", conn.get_channel(original.channel_id), timeout)
    verify_channel(restored, original)
    report.data["restoration"] = "verified"
    report.save()


async def run(args, report):
    recovery = None
    if args.restore_from:
        recovery = json.loads(args.restore_from.read_text())
        args.address = recovery["address"]
    report.data.update(address=args.address, transport="ble", apply=args.apply,
                       not_tested=["audio_rx", "audio_tx", "ptt", "rf_measurement"])
    conn = CommandConnection.new_ble(args.address)
    original = None
    restore_needed = False
    try:
        await report.step("connect", conn.connect(), args.timeout)
        state = await report.step("initial_status", conn.get_status(), args.timeout)
        if state.is_in_tx:
            raise RuntimeError("The radio is transmitting; its memory will not be changed.")
        report.data["region"] = state.curr_region
        if recovery:
            original = Channel.model_validate(recovery["original_channel"])
            region = recovery["region"]
            report.data.update(original_channel=original.model_dump(mode="json"), region=region,
                               recovery_source=str(args.restore_from.resolve()))
            report.save()
            if args.apply:
                await restore(conn, original, region, report, args.timeout)
                report.data["result"] = "recovery_passed"
            else:
                report.data["result"] = "recovery_prepared"
            return

        region = state.curr_region
        index = args.channel if args.channel is not None else state.curr_ch_id
        original = await report.step("original_channel", conn.get_channel(index), args.timeout)
        if original.fixed_freq:
            raise RuntimeError("This memory has a locked frequency.")
        if original.rx_freq == args.rx_mhz:
            raise RuntimeError("The proposed frequency already equals the original; this would not validate a change.")
        original_band = original.rx_freq < 200
        if original_band != (args.rx_mhz < 200):
            raise RuntimeError("This test preserves the original memory band.")
        updated = original.model_copy(update={"rx_freq": args.rx_mhz})
        # Validate serialization of both snapshots before any write.
        original.to_protocol().to_bytes()
        updated.to_protocol().to_bytes()
        report.data.update(original_channel=original.model_dump(mode="json"),
                           temporary_channel=updated.model_dump(mode="json"),
                           restoration="not_needed")
        report.save()
        if not args.apply:
            report.data["result"] = "frequency_change_prepared"
            return

        # The snapshot is saved. A timed-out write may still change the radio,
        # so restoration is armed before the first send.
        restore_needed = True
        report.data["restoration"] = "pending"
        report.save()
        try:
            await report.step("temporary_write", conn.set_channel(updated), args.timeout)
            readback = await report.step("temporary_readback", conn.get_channel(index), args.timeout)
            verify_channel(readback, updated)
            report.data["temporary_readback_verified"] = True
            await asyncio.sleep(args.hold)
            status = await report.step("temporary_status", conn.get_status(), args.timeout)
            if status.curr_region != region or status.is_in_tx:
                raise RuntimeError("State changed during the test; memory restoration will be attempted.")
        finally:
            # Reconnect only after losing the link. Saved snapshots and the recovery
            # command support manual restoration after a persistent outage.
            try:
                if not conn.is_connected():
                    conn = CommandConnection.new_ble(args.address)
                    await report.step("restore_reconnect", conn.connect(), args.timeout)
                await restore(conn, original, region, report, args.timeout)
                restore_needed = False
            except BaseException as error:
                report.data.update(restoration="failed", restore_error=repr(error))
                report.save()
                raise
        report.data["result"] = "frequency_change_passed"
    finally:
        if restore_needed:
            print("RESTORATION NOT VERIFIED. Use --restore-from with this report and --apply.", file=sys.stderr)
        if conn.is_connected():
            await report.step("disconnect", conn.disconnect(), args.timeout)


def main():
    args = parse_args()
    filename = datetime.now().strftime("%Y%m%d-%H%M%S-%f") + "-frequency.json"
    report = Report(args.output or RESULTS_DIRECTORY / filename)
    code = 1
    try:
        asyncio.run(run(args, report))
        code = 0
    except KeyboardInterrupt:
        report.data["result"] = "interrupted"
        code = 130
    except Exception as error:
        report.data.update(result="failed", error_type=type(error).__name__, error=str(error))
        print(f"{type(error).__name__}: {error}", file=sys.stderr)
    finally:
        report.data["finished_utc"] = datetime.now(timezone.utc).isoformat()
        report.save()
        print(f"Report: {report.path.resolve()}")
    return code


if __name__ == "__main__":
    sys.exit(main())
