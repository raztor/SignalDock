import { dispose } from '@livekit/rtc-node';

/** Process-wide CLI shutdown only, after every media service/room has closed. */
export async function disposeMediaRuntime(): Promise<void> {
  await dispose();
}
