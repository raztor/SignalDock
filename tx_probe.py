"""Bounded macOS TX/PTT tone test with minimum power and configuration restoration."""
import argparse
import asyncio
from datetime import datetime, timezone
import json
from pathlib import Path
import time
import sys

from benlink.command import CommandConnection, StatusChangedEvent
from frequency_probe import restore, verify_channel
from radio_probe import Report


async def run(args, report):
    root = Path(__file__).resolve().parent
    job = json.loads((root / "results/tx-two-tones.job.json").read_text())
    if job.get("kind") != "two-tone-test" or not 0 < job["seconds"] <= 2:
        raise RuntimeError("Prepare the two-tone job with prepare_tx_test.py first.")
    report.data.update(address=args.address, transport="ble+IOBluetooth", events=[],
                       apply=args.apply, restoration="not_needed")
    conn = CommandConnection.new_ble(args.address)
    original = None
    restore_needed = False
    remove = None
    finished = None
    cancel_path = None
    try:
        await report.step("connect_ble", conn.connect(), 20)
        state = await report.step("initial_status", conn.get_status(), 10)
        original_settings = await report.step("original_settings", conn.get_settings(), 10)
        index = args.channel if args.channel is not None else state.curr_ch_id
        original = await report.step("original_channel", conn.get_channel(index), 10)
        report.data.update(original_channel=original.model_dump(mode="json"), region=state.curr_region,
                           original_settings=original_settings.model_dump(mode="json"))
        if state.is_in_tx or original.tx_disable or original.tx_mod != "FM":
            raise RuntimeError("The radio state is not valid for the TX test.")
        if original.tx_freq != args.frequency or original.rx_freq != args.frequency:
            raise RuntimeError("The test memory must have RX and TX set to the agreed frequency.")
        low_power = original.model_copy(update={"tx_at_max_power": False, "tx_at_med_power": False})
        test_settings = original_settings.model_copy(update={"channel_a": index, "channel_b": index,
                                                             "double_channel": 0, "scan": False})
        low_power.to_protocol().to_bytes()
        test_settings.to_protocol().to_bytes()
        report.data["temporary_channel"] = low_power.model_dump(mode="json")
        report.data["temporary_settings"] = test_settings.model_dump(mode="json")
        report.save()
        if not args.apply:
            report.data["result"] = "tx_test_prepared"
            return

        def on_event(event):
            if isinstance(event, StatusChangedEvent):
                report.data["events"].append({"utc": datetime.now(timezone.utc).isoformat(),
                                               "status": event.status.model_dump(mode="json")})
                print("TX state:", event.status.is_in_tx, flush=True)
                report.save()

        remove = conn.add_event_handler(on_event)
        await report.step("subscribe_status", conn.enable_event("HT_STATUS_CHANGED"), 10)
        restore_needed = True
        report.data["restoration"] = "pending"
        report.save()
        await report.step("minimum_power_write", conn.set_channel(low_power), 10)
        readback = await report.step("minimum_power_readback", conn.get_channel(original.channel_id), 10)
        verify_channel(readback, low_power)
        await report.step("select_test_channel", conn.set_settings(test_settings), 10)
        actual_settings = await report.step("test_settings_readback", conn.get_settings(), 10)
        if actual_settings.model_dump(mode="json") != test_settings.model_dump(mode="json"):
            raise RuntimeError("Channel selection does not match the test configuration.")
        state = await report.step("status_before_audio", conn.get_status(), 10)
        # This VR-N7500 kept reporting index 31 after A=9 and B=9 readback.
        # Validate selection against settings and memory, rather than inferring it
        # solely from a field whose semantics remain unconfirmed on this model.
        report.data["status_channel_matches_selection"] = state.curr_ch_id == index
        if state.curr_region != report.data["region"] or state.is_in_tx:
            raise RuntimeError("The region or TX state does not permit this test.")

        # A stale job must never transmit after the original memory is restored.
        job["expires_epoch"] = time.time() + 45
        job_path = report.path.with_suffix(".tx-job.json")
        cancel_path = report.path.with_suffix(".cancel")
        job["cancel_path"] = str(cancel_path.resolve())
        job_path.write_text(json.dumps(job) + "\n")
        process = await asyncio.create_subprocess_exec(
            "bash", str(root / "tools/run_mac_bluetooth_probe.sh"), "--audio-tx", str(job_path.resolve()),
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT, cwd=root)
        finished = asyncio.create_task(process.communicate())
        # Events capture short TX transitions; periodic polling supplies additional
        # evidence, and checking the final state is mandatory.
        while not finished.done():
            done, _ = await asyncio.wait([finished], timeout=0.4)
            if done:
                break
            if time.time() > job["expires_epoch"] + 20:
                raise TimeoutError("The native utility did not finish within the deadline.")
            status = await asyncio.wait_for(conn.get_status(), timeout=10)
            report.data["events"].append({"utc": datetime.now(timezone.utc).isoformat(),
                                           "source": "poll", "status": status.model_dump(mode="json")})
        output, _ = await finished
        lines = output.decode(errors="replace").splitlines()
        native_path = next((line.removeprefix("Report: ") for line in lines if line.startswith("Report: ")), None)
        if process.returncode or not native_path:
            raise RuntimeError("The native utility failed: " + "\n".join(lines)[-1200:])
        native = json.loads(Path(native_path).read_text())
        report.data.update(native_report=native_path,
                           native_summary={key: native.get(key) for key in
                                           ("result", "tx_chunks_attempted", "audio_end_first_status",
                                            "audio_end_second_status", "audio_close_status")})
        state = await report.step("final_status", conn.get_status(), 10)
        report.data["tx_observed"] = any(event["status"]["is_in_tx"] for event in report.data["events"])
        report.data["ptt_released"] = not state.is_in_tx
        if state.is_in_tx:
            raise RuntimeError("The radio is still transmitting; high power will not be restored. Stop transmission at the radio.")
        if native["result"] != "tx_audio_sent" or any(native.get(key) != 0 for key in
                ("audio_end_first_status", "audio_end_second_status", "audio_close_status")):
            raise RuntimeError("Audio transmission or shutdown did not complete successfully.")
        if not report.data["tx_observed"]:
            raise RuntimeError("TX was not observed through BLE; PTT is not confirmed.")
        report.data["result"] = "tx_ptt_protocol_passed"
        report.data["audio_confirmed_by_listener"] = False
    finally:
        # If BLE fails while audio is still opening, cancel and await the native
        # job before restoring power to prevent a late high-power transmission.
        if finished is not None and not finished.done():
            cancel_path.write_text("cancel\n")
            report.data["native_cancel_requested"] = True
            try:
                await asyncio.wait_for(asyncio.shield(finished), timeout=50)
            except Exception as error:
                report.data["native_shutdown_error"] = repr(error)
            report.save()
        if restore_needed and original:
            try:
                if not conn.is_connected():
                    conn = CommandConnection.new_ble(args.address)
                    await report.step("restore_reconnect", conn.connect(), 20)
                status = await report.step("restore_safety_status", conn.get_status(), 10)
                if status.is_in_tx:
                    raise RuntimeError("PTT remains active: retaining minimum power and the recovery snapshot.")
                try:
                    await restore(conn, original, report.data["region"], report, 10)
                finally:
                    if status.curr_region == report.data["region"]:
                        await report.step("restore_settings_write", conn.set_settings(original_settings), 10)
                        restored_settings = await report.step("restore_settings_readback", conn.get_settings(), 10)
                        if restored_settings.model_dump(mode="json") != original_settings.model_dump(mode="json"):
                            report.data["restoration"] = "failed"
                            raise RuntimeError("Restoration of the original settings was not verified.")
                restore_needed = False
            except BaseException as error:
                report.data.update(restoration="failed", restore_error=repr(error))
                report.save()
                raise
        if remove:
            remove()
        if conn.is_connected():
            await report.step("disconnect_ble", conn.disconnect(), 10)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--address", required=True)
    parser.add_argument("--frequency", type=float, required=True, help="Previously agreed and programmed simplex frequency")
    parser.add_argument("--channel", type=int, choices=range(256), metavar="0..255", help="Test memory; original selection is restored afterward")
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    path = Path(__file__).resolve().parent / "results" / (datetime.now().strftime("%Y%m%d-%H%M%S-%f") + "-tx.json")
    report = Report(path)
    code = 1
    try:
        asyncio.run(run(args, report))
        code = 0
    except KeyboardInterrupt:
        report.data["result"] = "interrupted"
        code = 130
    except Exception as error:
        report.data.update(result="failed", error=str(error), error_type=type(error).__name__)
        print(f"{type(error).__name__}: {error}", file=sys.stderr)
    finally:
        report.data["finished_utc"] = datetime.now(timezone.utc).isoformat()
        report.save()
        print("Report:", report.path.resolve())
    return code


if __name__ == "__main__":
    sys.exit(main())
