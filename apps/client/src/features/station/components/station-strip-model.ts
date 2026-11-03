/**
 * Pure presentation for the persistent station strip (node-testable).
 */
import type { RadioView } from '@signaldock/contracts';
import { TX_RELEASED_MESSAGE } from '../../media/controller';
import {
  confidencePresentation,
  connectionPresentation,
  formatTuning,
  sameTuning,
  txPresentation,
  type ConfidencePresentation,
  type StatusPresentation,
  type TxPresentation,
} from '../station-model';

export const UNKNOWN_FREQUENCY = '— — —';

export interface StationStripPresentation {
  name: string;
  status: StatusPresentation;
  /** Confirmed/observed tuning, or `UNKNOWN_FREQUENCY`. */
  frequency: string;
  known: boolean;
  confidence: ConfidencePresentation;
  /** Desired tuning while it differs from the observed one, else ''. */
  requested: string;
  /** Radio-reported TX state when it is not idle (unknown is shown). */
  tx: TxPresentation | undefined;
  /** Screen-reader summary of name, frequency and pending request. */
  accessibilityLabel: string;
}

export function stationStripPresentation(input: {
  selected: RadioView | undefined;
  loaded: boolean;
}): StationStripPresentation {
  const { selected, loaded } = input;
  const name = selected?.displayName || 'Selected radio';
  const snapshot = selected?.snapshot ?? null;
  const status: StatusPresentation = selected
    ? connectionPresentation(selected)
    : loaded
      ? { tone: 'error', label: 'Radio unavailable', pulse: false }
      : { tone: 'pending', label: 'Loading radio', pulse: true };
  const observed = snapshot?.observedTuning;
  const desired = snapshot?.desiredTuning;
  const confidence = confidencePresentation(
    observed ? snapshot?.tuningConfidence : undefined,
  );
  const frequency = observed ? formatTuning(observed) : UNKNOWN_FREQUENCY;
  const requested =
    desired && !sameTuning(desired, observed) ? formatTuning(desired) : '';
  // Unknown TX state is shown, never folded into "idle".
  const tx =
    snapshot && snapshot.txState !== 'idle'
      ? txPresentation(snapshot.txState)
      : undefined;
  const frequencyLabel = observed
    ? `${frequency}, ${confidence.label.toLowerCase()}`
    : 'frequency unknown';
  return {
    name,
    status,
    frequency,
    known: Boolean(observed),
    confidence,
    requested,
    tx,
    accessibilityLabel: `${name}, ${frequencyLabel}${
      requested ? `, requested ${requested}` : ''
    }`,
  };
}

/**
 * The compact PTT stays mounted while a press is active so its release always
 * arrives, even if transmit access changes mid-press.
 */
export function showStripPtt(input: {
  available: boolean;
  canTransmit: boolean;
  transmitting: boolean;
  pending: boolean;
}): boolean {
  return (
    input.available &&
    (input.canTransmit || input.transmitting || input.pending)
  );
}

/** How long the strip shows why a transmission ended on its own. */
export const TX_STOP_NOTICE_MS = 6_000;

/**
 * The reason to show when a transmission (pending or active) ends without the
 * operator's own release: the 30 s limit, an interruption or lost access.
 * Returns undefined for a normal release or while TX is still active.
 */
export function txStopNotice(input: {
  wasActive: boolean;
  active: boolean;
  message: string;
}): string | undefined {
  if (!input.wasActive || input.active) return undefined;
  const message = input.message.trim();
  return message && message !== TX_RELEASED_MESSAGE ? message : undefined;
}
