import { describe, expect, it } from 'vitest';
import { SignalDockError, type RecentServer } from '@signaldock/contracts';
import {
  displayAddress,
  formatVersion,
  healthFromError,
  healthFromInfo,
  healthPresentation,
  hostKind,
  lastUsedLabel,
  normalizeStationInput,
  parseScannedStation,
  relativeTime,
  sortRecentStations,
  stationCardLabel,
} from './server-model';

function ok(input: string) {
  const result = normalizeStationInput(input);
  if (!result.ok)
    throw new Error(`Expected ${input} to be valid: ${result.error}`);
  return result;
}
function error(input: string) {
  const result = normalizeStationInput(input);
  if (result.ok) throw new Error(`Expected ${input} to be rejected`);
  return result;
}

describe('hostKind', () => {
  it('classifies loopback, private and public hosts', () => {
    expect(hostKind('localhost')).toBe('loopback');
    expect(hostKind('127.0.0.1')).toBe('loopback');
    expect(hostKind('[::1]')).toBe('loopback');
    expect(hostKind('192.168.1.20')).toBe('private');
    expect(hostKind('10.0.0.5')).toBe('private');
    expect(hostKind('172.16.4.1')).toBe('private');
    expect(hostKind('172.32.4.1')).toBe('public');
    expect(hostKind('169.254.10.2')).toBe('private');
    expect(hostKind('[fd12:3456::1]')).toBe('private');
    expect(hostKind('station.local')).toBe('private');
    expect(hostKind('radio.example.com')).toBe('public');
    expect(hostKind('8.8.8.8')).toBe('public');
  });
});

describe('normalizeStationInput', () => {
  it('asks for an address without reporting an error on empty input', () => {
    expect(normalizeStationInput('   ')).toEqual({
      ok: false,
      error: 'Enter the station address.',
      empty: true,
    });
  });

  it('adds https:// when the scheme is missing', () => {
    expect(ok('radio.example.com')).toEqual({
      ok: true,
      url: 'https://radio.example.com/',
      schemeAdded: 'https',
      hostKind: 'public',
    });
    expect(ok(' radio.example.com/station ').url).toBe(
      'https://radio.example.com/station/',
    );
    expect(ok('radio.example.com:8443').url).toBe(
      'https://radio.example.com:8443/',
    );
  });

  it('uses http:// for loopback addresses without a scheme', () => {
    expect(ok('localhost:3000')).toMatchObject({
      url: 'http://localhost:3000/',
      schemeAdded: 'http',
      hostKind: 'loopback',
    });
    expect(ok('127.0.0.1:8080/api').url).toBe('http://127.0.0.1:8080/api/');
    expect(ok('[::1]:3000').url).toBe('http://[::1]:3000/');
  });

  it('keeps an explicit scheme and canonicalises the trailing slash', () => {
    const result = ok('HTTPS://Radio.Example.com/prefix///');
    expect(result.url).toBe('https://radio.example.com/prefix/');
    expect(result.schemeAdded).toBeUndefined();
    expect(ok('http://localhost:3000').url).toBe('http://localhost:3000/');
  });

  it('requires HTTPS for private network addresses, as the SDK rules do', () => {
    expect(error('http://192.168.1.20:3000').error).toMatch(
      /must use https:\/\/.*localhost/,
    );
    expect(ok('192.168.1.20:3000')).toMatchObject({
      url: 'https://192.168.1.20:3000/',
      hostKind: 'private',
    });
    expect(error('http://radio.example.com').error).toMatch(/Use https:\/\//);
  });

  it('rejects credentials, queries, fragments, spaces and other schemes', () => {
    expect(error('https://user:pw@radio.example.com').error).toMatch(
      /user name or password/,
    );
    expect(error('radio.example.com/?a=1').error).toMatch(/\? or #/);
    expect(error('https://radio.example.com/#top').error).toMatch(/\? or #/);
    expect(error('radio example.com').error).toMatch(/spaces/);
    expect(error('ftp://radio.example.com').error).toMatch(/https:\/\//);
    expect(error('mailto:admin@example.com').error).toMatch(/full address/);
    expect(error('https:radio.example.com').error).toMatch(/full address/);
  });
});

describe('parseScannedStation', () => {
  it('accepts only explicit http(s) station URLs', () => {
    expect(parseScannedStation('https://radio.example.com')).toMatchObject({
      ok: true,
      url: 'https://radio.example.com/',
    });
    expect(parseScannedStation('WIFI:S:home;T:WPA;P:secret;;')).toMatchObject({
      ok: false,
      error: 'This QR code is not a station address.',
    });
    expect(parseScannedStation('radio.example.com').ok).toBe(false);
    expect(parseScannedStation('http://10.0.0.2').ok).toBe(false);
  });
});

describe('displayAddress', () => {
  it('drops https:// and the trailing slash but keeps http://', () => {
    expect(displayAddress('https://radio.example.com/station/')).toBe(
      'radio.example.com/station',
    );
    expect(displayAddress('http://localhost:3000/')).toBe(
      'http://localhost:3000',
    );
  });
});

const info = {
  product: 'SignalDock',
  instanceId: '0f6f0b5c-1d1f-4f43-9f43-7d6f8f1a2b3c',
  displayName: 'Base',
  version: '0.1.0',
  protocol: { min: 1, max: 1 },
  identity: {
    keyId: `sha256:${'a'.repeat(64)}`,
    publicKey: 'key',
    algorithm: 'Ed25519',
  },
  routes: { api: 'api/v1', events: 'api/v1/events', media: 'api/v1/media' },
  features: {
    multiRadio: true,
    authentication: 'local',
    radioControl: true,
    liveAudio: true,
    pushRelay: 'unavailable',
  },
} as const;

describe('health', () => {
  it('formats versions with a single v prefix', () => {
    expect(formatVersion('0.1.0')).toBe('v0.1.0');
    expect(formatVersion('v2.0.0')).toBe('v2.0.0');
  });

  it('presents checking, online and sign-in-unavailable stations', () => {
    expect(healthPresentation(undefined)).toEqual({
      tone: 'pending',
      label: 'Checking…',
      pulse: true,
    });
    expect(healthPresentation({ state: 'checking' }).label).toBe('Checking…');
    expect(healthPresentation(healthFromInfo(info))).toEqual({
      tone: 'ok',
      label: 'Online · v0.1.0',
      pulse: false,
    });
    const noSignIn = healthPresentation(
      healthFromInfo({
        ...info,
        features: { ...info.features, authentication: 'unavailable' },
      }),
    );
    expect(noSignIn.tone).toBe('warning');
    expect(noSignIn.label).toBe('Online · v0.1.0');
    expect(noSignIn.detail).toMatch(/Sign-in is not available/);
  });

  it('maps timeouts and network failures to Unreachable', () => {
    const timeout = healthFromError(new Error('aborted'), true);
    expect(timeout).toEqual({
      state: 'unreachable',
      reason: 'No answer within 4 seconds.',
    });
    expect(healthPresentation(timeout)).toMatchObject({
      tone: 'off',
      label: 'Unreachable',
    });
    expect(healthFromError(new TypeError('Failed to fetch'), false)).toEqual({
      state: 'unreachable',
      reason: 'The station could not be reached.',
    });
    expect(
      healthFromError(
        new SignalDockError(
          'RADIO_UNAVAILABLE',
          'Server discovery failed (HTTP 502).',
        ),
        false,
      ),
    ).toEqual({
      state: 'unreachable',
      reason: 'Server discovery failed (HTTP 502).',
    });
  });

  it('distinguishes identity changes and incompatible protocols', () => {
    const changed = healthFromError(
      new SignalDockError('INSTANCE_IDENTITY_CHANGED', 'changed'),
      false,
    );
    expect(changed.state).toBe('identity-changed');
    expect(healthPresentation(changed)).toMatchObject({
      tone: 'error',
      label: 'Identity changed',
    });
    const incompatible = healthFromError(
      new SignalDockError('API_INCOMPATIBLE', 'Needs another protocol.'),
      false,
    );
    expect(healthPresentation(incompatible)).toMatchObject({
      tone: 'warning',
      label: 'Incompatible version',
      detail: 'Needs another protocol.',
    });
  });
});

describe('relative time', () => {
  const now = Date.parse('2026-11-03T12:00:00Z');
  const ago = (ms: number) => new Date(now - ms).toISOString();
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;

  it('describes recent use compactly', () => {
    expect(relativeTime(ago(10_000), now)).toBe('Just now');
    expect(relativeTime(ago(-5 * minute), now)).toBe('Just now');
    expect(relativeTime(ago(5 * minute), now)).toBe('5 min ago');
    expect(relativeTime(ago(3 * hour + 59 * minute), now)).toBe('3 h ago');
    expect(relativeTime(ago(30 * hour), now)).toBe('Yesterday');
    expect(relativeTime(ago(4 * day), now)).toBe('4 days ago');
    expect(relativeTime(ago(8 * day), now)).toBe('1 week ago');
    expect(relativeTime(ago(20 * day), now)).toBe('2 weeks ago');
  });

  it('falls back to a date for older use', () => {
    const older = new Date(now - 60 * day);
    const label = relativeTime(older.toISOString(), now);
    expect(label).toMatch(/^[A-Z][a-z]{2} \d{1,2}$/);
    const lastYear = relativeTime('2024-03-04T12:00:00Z', now);
    expect(lastYear).toMatch(/^Mar [34], 2024$/);
    expect(relativeTime('not a date', now)).toBeUndefined();
  });

  it('builds the card label', () => {
    expect(lastUsedLabel(ago(10_000), now)).toBe('Last used just now');
    expect(lastUsedLabel(ago(2 * hour), now)).toBe('Last used 2 h ago');
    expect(lastUsedLabel('bad', now)).toBe('Last use unknown');
  });
});

describe('recent stations', () => {
  const server = (alias: string, lastConnectedAt: string): RecentServer => ({
    baseUrl: `https://${alias.toLowerCase()}.example.com/`,
    alias,
    instanceId: info.instanceId,
    identity: info.identity,
    lastConnectedAt,
  });

  it('orders by last use, newest first', () => {
    const sorted = sortRecentStations([
      server('Old', '2026-01-01T00:00:00Z'),
      server('New', '2026-11-01T00:00:00Z'),
      server('Mid', '2026-06-01T00:00:00Z'),
    ]);
    expect(sorted.map((item) => item.alias)).toEqual(['New', 'Mid', 'Old']);
  });

  it('describes the card for screen readers with status in words', () => {
    const now = Date.parse('2026-11-03T12:00:00Z');
    expect(
      stationCardLabel(
        server('Base', '2026-11-03T11:55:00Z'),
        healthFromInfo(info),
        now,
      ),
    ).toBe(
      'Connect to Base, base.example.com. Online · v0.1.0. Last used 5 min ago.',
    );
  });
});
