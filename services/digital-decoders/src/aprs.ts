import { SignalDockError } from '@signaldock/contracts';

export const APRS_PARSER_VERSION = '1.0.0';

/** Parser intermediate, not a public packet/history DTO. */
export interface ParsedAprs {
  source: string;
  destination: string;
  path: string[];
  payload: string;
  kind:
    | 'position'
    | 'position_ambiguous'
    | 'position_unsupported'
    | 'message'
    | 'status'
    | 'telemetry'
    | 'weather'
    | 'other';
  position?: {
    latitude: number;
    longitude: number;
    symbolTable: string;
    symbol: string;
  };
  message?: { addressee: string; text: string; messageId?: string };
  comment?: string;
}

const station = /^[A-Z0-9]{1,6}(?:-(?:[0-9]|1[0-5]))?$/;
const destination = /^[A-Z0-9]{1,6}(?:-(?:[0-9]|1[0-5]))?$/;

export function parseAprsTnc2(raw: string): ParsedAprs {
  if (raw.length > 4096 || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(raw)) {
    throw new SignalDockError(
      'INVALID_ARGUMENT',
      'Packet length or control characters are invalid.',
    );
  }
  const line = raw.replace(/\r?\n$/, '');
  if (/[\r\n]/.test(line))
    throw new SignalDockError(
      'INVALID_ARGUMENT',
      'Exactly one packet is required.',
    );
  const divider = line.indexOf(':');
  const separator = line.indexOf('>');
  if (separator < 1 || divider < separator + 2)
    throw new SignalDockError(
      'INVALID_ARGUMENT',
      'Expected a TNC2 packet header.',
    );
  const source = line.slice(0, separator);
  const [to, ...path] = line.slice(separator + 1, divider).split(',');
  if (
    !station.test(source) ||
    !to ||
    !destination.test(to) ||
    path.length > 10 ||
    path.some((entry) => !/^[A-Za-z0-9-]{1,15}\*?$/.test(entry))
  ) {
    throw new SignalDockError(
      'INVALID_ARGUMENT',
      'Packet address or path is invalid.',
    );
  }
  const payload = line.slice(divider + 1);
  if (!payload)
    throw new SignalDockError(
      'INVALID_ARGUMENT',
      'The packet has no information field.',
    );
  const parsed: ParsedAprs = {
    source,
    destination: to,
    path,
    payload,
    kind: 'other',
  };
  if (['!', '=', '/', '@'].includes(payload[0]!)) {
    const timestamped = payload[0] === '/' || payload[0] === '@';
    const start = timestamped ? 8 : 1;
    if (timestamped && !/^\d{6}[zh/]/.test(payload.slice(1))) {
      throw new SignalDockError(
        'INVALID_ARGUMENT',
        'Invalid APRS position timestamp.',
      );
    }
    const coordinate = payload.slice(start, start + 19);
    if (
      /^\d{4}\.[\d ]{2}[NS].[\d ]{5}\.[\d ]{2}[EW].$/.test(coordinate) &&
      coordinate.includes(' ')
    ) {
      parsed.kind = 'position_ambiguous';
    } else {
      const match =
        /^(\d{2})(\d{2}\.\d{2})([NS])(.)(\d{3})(\d{2}\.\d{2})([EW])(.)$/.exec(
          coordinate,
        );
      if (!match) {
        parsed.kind = 'position_unsupported';
      } else {
        const latDegrees = Number(match[1]);
        const latMinutes = Number(match[2]);
        const lonDegrees = Number(match[5]);
        const lonMinutes = Number(match[6]);
        if (
          latDegrees > 90 ||
          lonDegrees > 180 ||
          latMinutes >= 60 ||
          lonMinutes >= 60 ||
          (latDegrees === 90 && latMinutes !== 0) ||
          (lonDegrees === 180 && lonMinutes !== 0)
        ) {
          throw new SignalDockError(
            'INVALID_ARGUMENT',
            'APRS coordinates are outside the valid range.',
          );
        }
        parsed.kind = 'position';
        parsed.position = {
          latitude:
            (latDegrees + latMinutes / 60) * (match[3] === 'S' ? -1 : 1),
          longitude:
            (lonDegrees + lonMinutes / 60) * (match[7] === 'W' ? -1 : 1),
          symbolTable: match[4]!,
          symbol: match[8]!,
        };
      }
    }
    parsed.comment = payload.slice(start + 19);
  } else if (payload[0] === ':' && payload[10] === ':') {
    const text = payload.slice(11);
    const split = text.lastIndexOf('{');
    parsed.kind = 'message';
    parsed.message = {
      addressee: payload.slice(1, 10).trim(),
      text: split >= 0 ? text.slice(0, split) : text,
      ...(split >= 0 ? { messageId: text.slice(split + 1) } : {}),
    };
  } else if (payload[0] === '>') {
    parsed.kind = 'status';
    parsed.comment = payload.slice(1);
  } else if (payload.startsWith('T#')) parsed.kind = 'telemetry';
  else if (payload[0] === '_') parsed.kind = 'weather';
  return parsed;
}

export function ax25Fcs(bytes: Uint8Array): number {
  let crc = 0xffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++)
      crc = crc & 1 ? (crc >>> 1) ^ 0x8408 : crc >>> 1;
  }
  return crc ^ 0xffff;
}

/** AX.25 UI/APRS only. HDLC flags and bit stuffing are handled by the audio demodulator. */
export function ax25ToTnc2(frameInput: Uint8Array, includesFcs = true): string {
  if (frameInput.length < 16 || frameInput.length > 4096)
    throw new SignalDockError(
      'INVALID_ARGUMENT',
      'AX.25 frame length is invalid.',
    );
  let frame = frameInput;
  if (includesFcs) {
    const expected =
      frameInput[frameInput.length - 2]! |
      (frameInput[frameInput.length - 1]! << 8);
    frame = frameInput.subarray(0, -2);
    if (ax25Fcs(frame) !== expected)
      throw new SignalDockError(
        'INVALID_ARGUMENT',
        'AX.25 frame checksum does not match.',
      );
  }
  const addresses: string[] = [];
  let offset = 0;
  let ended = false;
  while (offset + 7 <= frame.length && addresses.length < 10) {
    const address = frame.subarray(offset, offset + 7);
    if (address.subarray(0, 6).some((byte) => byte & 1))
      throw new SignalDockError(
        'INVALID_ARGUMENT',
        'AX.25 address encoding is invalid.',
      );
    const call = String.fromCharCode(
      ...address.subarray(0, 6).map((byte) => byte >>> 1),
    ).trimEnd();
    const ssid = (address[6]! >>> 1) & 0x0f;
    if (!/^[A-Z0-9]{1,6}$/.test(call))
      throw new SignalDockError(
        'INVALID_ARGUMENT',
        'AX.25 callsign is invalid.',
      );
    const repeated = addresses.length > 1 && !!(address[6]! & 0x80);
    addresses.push(`${call}${ssid ? `-${ssid}` : ''}${repeated ? '*' : ''}`);
    offset += 7;
    if (address[6]! & 1) {
      ended = true;
      break;
    }
  }
  if (
    !ended ||
    addresses.length < 2 ||
    frame[offset] !== 0x03 ||
    frame[offset + 1] !== 0xf0
  ) {
    throw new SignalDockError(
      'CAPABILITY_UNSUPPORTED',
      'Only AX.25 UI frames with no layer-3 protocol are supported.',
    );
  }
  const payload = new TextDecoder('utf-8', { fatal: true }).decode(
    frame.subarray(offset + 2),
  );
  const text = `${addresses[1]}>${addresses[0]}${addresses.length > 2 ? `,${addresses.slice(2).join(',')}` : ''}:${payload}`;
  parseAprsTnc2(text);
  return text;
}
