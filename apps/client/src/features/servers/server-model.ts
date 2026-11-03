/**
 * Pure helpers for the server connection screen: station address entry,
 * recent-station health and "last used" text. No React Native imports, so the
 * node test environment can load this module.
 */
import { normalizeServerUrl } from '@signaldock/client-sdk';
import type { RecentServer, ServerInfo } from '@signaldock/contracts';

/** Health checks for saved stations give up after this long. */
export const HEALTH_TIMEOUT_MS = 4000;
/** An explicit connection attempt gives up after this long. */
export const CONNECT_TIMEOUT_MS = 10000;

// ─── Address entry ─────────────────────────────────────────────────────────

/**
 * loopback: this device (HTTP allowed for development); private: a LAN or
 * link-local address (HTTPS still required); public: anything else.
 */
export type HostKind = 'loopback' | 'private' | 'public';

const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '[::1]', '::1'];

/** Classifies a URL hostname (as `URL.hostname` reports it). */
export function hostKind(hostname: string): HostKind {
  const host = hostname.toLowerCase();
  if (LOOPBACK_HOSTS.includes(host)) return 'loopback';
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (ipv4) {
    const a = Number(ipv4[1]);
    const b = Number(ipv4[2]);
    if (a === 10) return 'private';
    if (a === 172 && b >= 16 && b <= 31) return 'private';
    if (a === 192 && b === 168) return 'private';
    if (a === 169 && b === 254) return 'private';
    return 'public';
  }
  const bare = host.replace(/^\[|\]$/g, '');
  if (/^f[cd][0-9a-f]{2}:/.test(bare) || /^fe[89ab][0-9a-f]:/.test(bare))
    return 'private';
  if (host.endsWith('.local') || host.endsWith('.lan')) return 'private';
  return 'public';
}

export type StationUrlResult =
  | {
      ok: true;
      /** Canonical base URL (trailing slash), as the client SDK stores it. */
      url: string;
      /** Scheme this helper added because the input had none. */
      schemeAdded?: 'https' | 'http';
      hostKind: HostKind;
    }
  | {
      ok: false;
      error: string;
      /** True when nothing was typed (no error needs to be shown yet). */
      empty: boolean;
    };

const SCHEME = /^([a-z][a-z0-9+.-]*):\/\//i;
/** `name:` not followed by a port number, e.g. `mailto:` or `https:host`. */
const BARE_SCHEME = /^([a-z][a-z0-9+.-]*):(?!\d)/i;

function invalid(error: string): StationUrlResult {
  return { ok: false, error, empty: false };
}

/**
 * Turns what a person typed into a station base URL. Adds `https://` when the
 * scheme is missing (`http://` for this device's loopback addresses) and then
 * applies the client SDK's rules: HTTPS everywhere, HTTP only on loopback, no
 * credentials, query or fragment.
 */
export function normalizeStationInput(input: string): StationUrlResult {
  const text = input.trim();
  if (!text)
    return { ok: false, error: 'Enter the station address.', empty: true };
  if (/\s/.test(text))
    return invalid('Remove the spaces from the station address.');
  let candidate = text;
  let schemeAdded: 'https' | 'http' | undefined;
  const scheme = SCHEME.exec(text)?.[1]?.toLowerCase();
  if (scheme) {
    if (scheme !== 'https' && scheme !== 'http')
      return invalid('Use an https:// station address.');
  } else if (BARE_SCHEME.test(text)) {
    return invalid('Use a full address such as https://radio.example.com.');
  } else {
    const host = text
      .replace(/^\/+/, '')
      .split(/[/?#]/)[0]!
      .replace(/:\d+$/, '')
      .replace(/^.*@/, '');
    schemeAdded = hostKind(host) === 'loopback' ? 'http' : 'https';
    candidate = `${schemeAdded}://${text.replace(/^\/+/, '')}`;
  }
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return invalid('This is not a valid address.');
  }
  if (!parsed.hostname) return invalid('This is not a valid address.');
  if (parsed.username || parsed.password)
    return invalid('Remove the user name or password from the address.');
  if (parsed.search || parsed.hash)
    return invalid('Remove the ? or # part from the address.');
  const kind = hostKind(parsed.hostname);
  if (parsed.protocol === 'http:' && kind !== 'loopback')
    return invalid(
      kind === 'private'
        ? 'This station must use https://. HTTP is allowed only for localhost on this device.'
        : 'Use https:// for this station. HTTP is allowed only for localhost on this device.',
    );
  try {
    return {
      ok: true,
      url: normalizeServerUrl(parsed.href),
      ...(schemeAdded ? { schemeAdded } : {}),
      hostKind: kind,
    };
  } catch (failure) {
    return invalid(
      failure instanceof Error ? failure.message : 'This address is not valid.',
    );
  }
}

/**
 * Validates the text of a scanned QR code. Only explicit http(s) URLs are
 * accepted so that unrelated codes (Wi-Fi, contacts, plain text) never turn
 * into a connection attempt.
 */
export function parseScannedStation(data: string): StationUrlResult {
  const text = data.trim();
  if (!/^https?:\/\//i.test(text))
    return invalid('This QR code is not a station address.');
  return normalizeStationInput(text);
}

/** Short address for cards: no scheme, no trailing slash. */
export function displayAddress(baseUrl: string): string {
  return baseUrl.replace(/^https:\/\//i, '').replace(/\/+$/, '');
}

// ─── Health ────────────────────────────────────────────────────────────────

export type StationHealth =
  | { state: 'checking' }
  | {
      state: 'online';
      version: string;
      displayName: string;
      signIn: boolean;
    }
  | { state: 'unreachable'; reason: string }
  | { state: 'incompatible'; reason: string }
  | { state: 'identity-changed'; reason: string };

export type HealthTone = 'ok' | 'pending' | 'warning' | 'error' | 'off';

export interface HealthPresentation {
  tone: HealthTone;
  /** Visible status text, e.g. "Online · v0.1.0". Never colour-only. */
  label: string;
  /** Optional second line explaining a problem. */
  detail?: string;
  pulse: boolean;
}

export function formatVersion(version: string): string {
  const value = version.trim();
  return /^v\d/i.test(value) ? value : `v${value}`;
}

export function healthFromInfo(info: ServerInfo): StationHealth {
  return {
    state: 'online',
    version: info.version,
    displayName: info.displayName,
    signIn: info.features.authentication === 'local',
  };
}

/**
 * Maps a discovery failure. `timedOut` is true when the caller aborted the
 * request because of the health timeout.
 */
export function healthFromError(
  failure: unknown,
  timedOut: boolean,
): StationHealth {
  if (timedOut)
    return { state: 'unreachable', reason: 'No answer within 4 seconds.' };
  const code =
    failure && typeof failure === 'object' && 'code' in failure
      ? (failure as { code: unknown }).code
      : undefined;
  const message =
    failure instanceof Error && failure.message
      ? failure.message
      : 'The station could not be reached.';
  if (code === 'INSTANCE_IDENTITY_CHANGED')
    return { state: 'identity-changed', reason: message };
  if (code === 'API_INCOMPATIBLE')
    return { state: 'incompatible', reason: message };
  if (failure instanceof TypeError)
    return {
      state: 'unreachable',
      reason: 'The station could not be reached.',
    };
  return { state: 'unreachable', reason: message };
}

export function healthPresentation(
  health: StationHealth | undefined,
): HealthPresentation {
  if (!health || health.state === 'checking')
    return { tone: 'pending', label: 'Checking…', pulse: true };
  switch (health.state) {
    case 'online':
      return health.signIn
        ? {
            tone: 'ok',
            label: `Online · ${formatVersion(health.version)}`,
            pulse: false,
          }
        : {
            tone: 'warning',
            label: `Online · ${formatVersion(health.version)}`,
            detail: 'Sign-in is not available on this station.',
            pulse: false,
          };
    case 'unreachable':
      return {
        tone: 'off',
        label: 'Unreachable',
        detail: health.reason,
        pulse: false,
      };
    case 'incompatible':
      return {
        tone: 'warning',
        label: 'Incompatible version',
        detail: health.reason,
        pulse: false,
      };
    case 'identity-changed':
      return {
        tone: 'error',
        label: 'Identity changed',
        detail:
          'This address now answers with another station identity. Forget it and verify the station before reconnecting.',
        pulse: false,
      };
  }
}

// ─── Time ──────────────────────────────────────────────────────────────────

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

/**
 * Compact English relative time: "Just now", "5 min ago", "3 h ago",
 * "Yesterday", "4 days ago", "2 weeks ago", then a date ("Mar 4" in the same
 * year, "Mar 4, 2025" otherwise). Future timestamps (clock skew) read
 * "Just now"; unparseable ones return undefined.
 */
export function relativeTime(
  iso: string,
  now: number = Date.now(),
): string | undefined {
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return undefined;
  const elapsed = now - time;
  if (elapsed < MINUTE) return 'Just now';
  if (elapsed < HOUR) return `${Math.floor(elapsed / MINUTE)} min ago`;
  if (elapsed < DAY) return `${Math.floor(elapsed / HOUR)} h ago`;
  if (elapsed < 2 * DAY) return 'Yesterday';
  if (elapsed < 7 * DAY) return `${Math.floor(elapsed / DAY)} days ago`;
  if (elapsed < 28 * DAY) {
    const weeks = Math.floor(elapsed / (7 * DAY));
    return weeks === 1 ? '1 week ago' : `${weeks} weeks ago`;
  }
  const date = new Date(time);
  const label = `${MONTHS[date.getMonth()]} ${date.getDate()}`;
  return date.getFullYear() === new Date(now).getFullYear()
    ? label
    : `${label}, ${date.getFullYear()}`;
}

export function lastUsedLabel(iso: string, now: number = Date.now()): string {
  const relative = relativeTime(iso, now);
  return relative
    ? `Last used ${relative.replace(/^Just now$/, 'just now')}`
    : 'Last use unknown';
}

/** Most recently used first; the store already keeps this order. */
export function sortRecentStations(
  servers: readonly RecentServer[],
): RecentServer[] {
  return [...servers].sort(
    (a, b) =>
      (Date.parse(b.lastConnectedAt) || 0) -
      (Date.parse(a.lastConnectedAt) || 0),
  );
}

/** Screen-reader label for a recent-station card. */
export function stationCardLabel(
  server: RecentServer,
  health: StationHealth | undefined,
  now: number = Date.now(),
): string {
  const status = healthPresentation(health);
  return `Connect to ${server.alias}, ${displayAddress(server.baseUrl)}. ${status.label}. ${lastUsedLabel(server.lastConnectedAt, now)}.`;
}
