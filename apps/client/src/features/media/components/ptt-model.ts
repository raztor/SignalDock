/**
 * Pure push-to-talk presentation. Maps local media state, the radio's reported
 * TX state and access rules to what the PTT button shows. Pressing PTT is never
 * treated as confirmation of physical transmission: the radio's own `txState`
 * decides whether the carrier is confirmed, and uncertain radio states are
 * never shown as ready.
 *
 * Plain TypeScript (type-only imports) so it can be unit tested in node.
 */
import type { RadioSnapshot } from '@signaldock/contracts';

/** Client-side cap for one transmission, counted from the press. */
export const PTT_LIMIT_MS = 30_000;
/** After a release, radio TX states are shown as "Stopping…" for this long. */
export const PTT_RELEASE_GRACE_MS = 5_000;

export type RadioTxState = RadioSnapshot['txState'];

export type PttPhase =
  | 'ready'
  | 'preparing'
  | 'transmitting'
  | 'stopping'
  | 'busy'
  | 'uncertain'
  | 'unavailable';

/** Visual tone; `error` is also used for on-air transmission. */
export type PttTone = 'primary' | 'warning' | 'error' | 'neutral';

export interface PttInput {
  finishing?: boolean;
  /** Local media state from `useRadioMedia().state`. */
  pending: boolean;
  transmitting: boolean;
  /** `useRadioMedia().access`. */
  canTransmit: boolean;
  transmitReason: string;
  /** The server advertises live audio. */
  configured: boolean;
  /** This platform can run live audio. */
  supported: boolean;
  /** `selected.snapshot.txState` as reported by the radio. */
  radioTxState?: RadioTxState | undefined;
  /** Epoch ms of the current press (`useRadioMedia().txStartedAt`). */
  txStartedAt?: number | undefined;
  /** Epoch ms of the last release of a press that reached the radio. */
  releasedAt?: number | undefined;
  now: number;
  limitMs?: number;
}

export interface PttPresentation {
  phase: PttPhase;
  tone: PttTone;
  /** Main text inside the button. */
  label: string;
  /** Small second line inside the button ('' when none). */
  detail: string;
  /** One-line state description shown next to or below the button. */
  status: string;
  /** Why PTT cannot be used right now ('' when it can). */
  reason: string;
  /** A press is pending or transmitting (release must still reach the controller). */
  active: boolean;
  /** The button accepts presses: ready, or active so the release is delivered. */
  pressable: boolean;
  /** The radio confirmed the carrier (only meaningful while transmitting). */
  carrierConfirmed: boolean;
  /** Draw the 30 s ring. */
  showRing: boolean;
  /** Remaining part of the limit in 0..1 (0 when no ring). */
  ringFraction: number;
  /** Whole seconds left in this transmission (undefined when not active). */
  secondsLeft: number | undefined;
  /** Text for `accessibilityValue`, e.g. "On air, 23 seconds left". */
  accessibilityValue: string;
}

const radioKeyed: readonly RadioTxState[] = [
  'preparing',
  'tx_unconfirmed',
  'transmitting',
  'stopping',
];

/** Remaining fraction of the limit, clamped to 0..1. */
export function remainingFraction(
  txStartedAt: number | undefined,
  now: number,
  limitMs = PTT_LIMIT_MS,
): number {
  if (txStartedAt === undefined || !Number.isFinite(txStartedAt)) return 1;
  if (!(limitMs > 0)) return 0;
  const left = limitMs - (now - txStartedAt);
  return Math.min(1, Math.max(0, left / limitMs));
}

/** Whole seconds left (rounded up), clamped to 0..limit. */
export function secondsLeft(
  txStartedAt: number | undefined,
  now: number,
  limitMs = PTT_LIMIT_MS,
): number {
  const limitSeconds = Math.ceil(Math.max(0, limitMs) / 1000);
  if (txStartedAt === undefined || !Number.isFinite(txStartedAt))
    return limitSeconds;
  const left = limitMs - (now - txStartedAt);
  return Math.min(limitSeconds, Math.max(0, Math.ceil(left / 1000)));
}

function idle(
  phase: PttPhase,
  tone: PttTone,
  label: string,
  status: string,
  reason = '',
  detail = '',
): PttPresentation {
  return {
    phase,
    tone,
    label,
    detail,
    status,
    reason,
    active: false,
    pressable: phase === 'ready',
    carrierConfirmed: false,
    showRing: false,
    ringFraction: 0,
    secondsLeft: undefined,
    accessibilityValue: reason ? `${label}. ${reason}` : label,
  };
}

export function pttPresentation(input: PttInput): PttPresentation {
  const limitMs = input.limitMs ?? PTT_LIMIT_MS;
  const radio = input.radioTxState;
  if (input.transmitting || input.pending) {
    const fraction = remainingFraction(input.txStartedAt, input.now, limitMs);
    const left = secondsLeft(input.txStartedAt, input.now, limitMs);
    const seconds = `${left} s left`;
    const spoken = `${left} ${left === 1 ? 'second' : 'seconds'} left`;
    if (input.finishing)
      return {
        phase: 'stopping',
        tone: 'warning',
        label: 'Finishing',
        detail: seconds,
        status: 'Finishing captured audio…',
        reason: '',
        active: true,
        pressable: true,
        carrierConfirmed: radio === 'transmitting',
        showRing: true,
        ringFraction: fraction,
        secondsLeft: left,
        accessibilityValue: 'Finishing captured audio.',
      };
    if (input.transmitting) {
      const carrierConfirmed = radio === 'transmitting';
      return {
        phase: 'transmitting',
        tone: 'error',
        label: 'On air',
        detail: seconds,
        status: carrierConfirmed
          ? 'Transmitting · release to stop'
          : 'TX audio active · carrier confirmation pending',
        reason: '',
        active: true,
        pressable: true,
        carrierConfirmed,
        showRing: true,
        ringFraction: fraction,
        secondsLeft: left,
        accessibilityValue: carrierConfirmed
          ? `On air, ${spoken}`
          : `TX audio active, carrier unconfirmed, ${spoken}`,
      };
    }
    return {
      phase: 'preparing',
      tone: 'warning',
      label: 'Preparing',
      detail: 'Keep holding',
      status: 'Requesting transmit from the radio…',
      reason: '',
      active: true,
      pressable: true,
      carrierConfirmed: false,
      showRing: true,
      ringFraction: fraction,
      secondsLeft: left,
      accessibilityValue: `Preparing, keep holding, ${spoken}`,
    };
  }
  if (!input.supported)
    return idle(
      'unavailable',
      'neutral',
      'Unavailable',
      'Live audio is not available on this device yet.',
      'Live audio works in the web app for now.',
    );
  if (!input.configured)
    return idle(
      'unavailable',
      'neutral',
      'Unavailable',
      'Live audio is not configured.',
      'Live audio is not configured on this server.',
    );
  const releasing =
    input.releasedAt !== undefined &&
    input.now >= input.releasedAt &&
    input.now - input.releasedAt < PTT_RELEASE_GRACE_MS;
  if (
    radio === 'stopping' ||
    (releasing && radio && radioKeyed.includes(radio))
  )
    return idle(
      'stopping',
      'warning',
      'Stopping…',
      'Waiting for the radio to stop transmitting.',
    );
  if (radio === 'stop_unconfirmed')
    return idle(
      'uncertain',
      'error',
      'Stop unconfirmed',
      'The radio has not confirmed that transmission stopped.',
      'Check the radio before transmitting again.',
    );
  if (radio === 'unknown')
    return idle(
      'uncertain',
      'warning',
      'TX unknown',
      "The radio's transmit state is unknown.",
      input.transmitReason || 'Wait until the radio reports its TX state.',
    );
  if (radio && radioKeyed.includes(radio))
    return idle(
      'busy',
      'error',
      'Radio on air',
      'The radio is transmitting.',
      input.transmitReason || 'Wait until the radio stops transmitting.',
    );
  if (!input.canTransmit)
    return idle(
      'unavailable',
      'neutral',
      'Unavailable',
      'Transmission unavailable.',
      input.transmitReason || 'Transmission is unavailable.',
    );
  return idle(
    'ready',
    'primary',
    'Hold to talk',
    `Ready · ${Math.round(limitMs / 1000)} s limit per transmission`,
    '',
    `${Math.round(limitMs / 1000)} s max`,
  );
}
