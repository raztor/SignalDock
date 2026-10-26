import { createHash, randomUUID } from 'node:crypto';
import {
  IdSchema,
  TimestampSchema,
  SignalDockError,
  type AuthenticationPort,
  type PacketRecord,
  type PacketSource,
  type PositionRecord,
  type Principal,
} from '@signaldock/contracts';
import {
  APRS_PARSER_VERSION,
  ax25ToTnc2,
  parseAprsTnc2,
} from '@signaldock/digital-decoders';
import type { DigitalRepository, PacketQuery } from './repository.js';

export interface ReceivedPacket {
  packetId?: string;
  instanceId: string;
  radioId: string;
  receivedAt: string;
  source: PacketSource;
  rawText?: string;
  rawFrame?: Uint8Array;
  includesFcs?: boolean;
  frequencyHz?: number;
  attribution: PacketRecord['attribution'];
}

/** Normalizes bounded source evidence and preserves malformed/unsupported frames without a fabricated position. */
export function normalizeReceivedPacket(input: ReceivedPacket): PacketRecord {
  IdSchema.parse(input.instanceId);
  IdSchema.parse(input.radioId);
  TimestampSchema.parse(input.receivedAt);
  const packetId = IdSchema.parse(input.packetId ?? randomUUID());
  if (
    input.frequencyHz !== undefined &&
    (!Number.isSafeInteger(input.frequencyHz) || input.frequencyHz <= 0)
  )
    throw new SignalDockError(
      'INVALID_ARGUMENT',
      'Frequency must be a positive integer Hz value.',
    );
  if (
    !['native', 'recording', 'aprs_is'].includes(input.source) ||
    !['confirmed', 'inferred', 'unknown'].includes(input.attribution)
  )
    throw new SignalDockError(
      'INVALID_ARGUMENT',
      'Packet source context is invalid.',
    );
  if ((input.rawFrame === undefined) === (input.rawText === undefined))
    throw new SignalDockError(
      'INVALID_ARGUMENT',
      'Provide exactly one native frame or TNC2 line.',
    );
  if (
    (input.rawFrame?.length ?? 0) > 4096 ||
    Buffer.byteLength(input.rawText ?? '', 'utf8') > 4096
  )
    throw new SignalDockError(
      'INVALID_ARGUMENT',
      'Packet exceeds the source byte limit.',
    );
  const packet: PacketRecord = {
    packetId,
    instanceId: input.instanceId,
    radioId: input.radioId,
    receivedAt: new Date(input.receivedAt).toISOString(),
    source: input.source,
    ...(input.rawFrame
      ? { rawFrameBase64: Buffer.from(input.rawFrame).toString('base64') }
      : {}),
    ...(input.rawText === undefined ? {} : { rawText: input.rawText }),
    ...(input.frequencyHz === undefined
      ? {}
      : { frequencyHz: input.frequencyHz }),
    attribution: input.attribution,
    parserVersion: APRS_PARSER_VERSION,
    path: [],
    kind: 'malformed',
  };
  try {
    const rawText =
      input.rawText ?? ax25ToTnc2(input.rawFrame!, input.includesFcs ?? false);
    const parsed = parseAprsTnc2(rawText);
    packet.rawText = rawText;
    packet.callsign = parsed.source;
    packet.destination = parsed.destination;
    packet.path = parsed.path;
    packet.kind = parsed.kind;
    packet.parsed = {
      payload: parsed.payload,
      ...(parsed.comment === undefined ? {} : { comment: parsed.comment }),
      ...(parsed.message ? { message: parsed.message } : {}),
    };
    if (parsed.position)
      packet.position = {
        positionId: randomUUID(),
        packetId,
        instanceId: input.instanceId,
        radioId: input.radioId,
        callsign: parsed.source,
        lat: parsed.position.latitude,
        lon: parsed.position.longitude,
        symbol: parsed.position.symbolTable + parsed.position.symbol,
        receivedAt: packet.receivedAt,
        source: input.source,
      };
  } catch (error) {
    packet.kind =
      error instanceof SignalDockError &&
      error.code === 'CAPABILITY_UNSUPPORTED'
        ? 'unsupported'
        : 'malformed';
    packet.parsed = {
      error:
        error instanceof SignalDockError
          ? error.message
          : 'The frame cannot be parsed.',
    };
  }
  return packet;
}

export class AprsService {
  constructor(
    private readonly repository: DigitalRepository,
    private readonly auth: AuthenticationPort,
    private readonly now = Date.now,
  ) {}
  /** Internal driver/worker entry point. There is intentionally no public packet-injection route. */
  async ingest(
    input: ReceivedPacket,
  ): Promise<{ packet: PacketRecord; duplicate: boolean }> {
    const packet = normalizeReceivedPacket(input);
    const fingerprint = createHash('sha256')
      .update(packet.rawText ?? packet.rawFrameBase64 ?? '')
      .digest('hex');
    if (await this.repository.ingest(packet, fingerprint))
      return { packet, duplicate: false };
    const existing = await this.repository.packet(
      packet.instanceId,
      packet.packetId,
    );
    if (
      !existing ||
      existing.radioId !== packet.radioId ||
      existing.receivedAt !== packet.receivedAt ||
      existing.source !== packet.source ||
      existing.rawText !== packet.rawText ||
      existing.rawFrameBase64 !== packet.rawFrameBase64 ||
      existing.frequencyHz !== packet.frequencyHz ||
      existing.attribution !== packet.attribution
    ) {
      throw new SignalDockError(
        'OPERATION_CONFLICT',
        'A packet ID was reused with different source evidence.',
      );
    }
    return { packet: existing, duplicate: true };
  }
  async listPackets(
    principal: Principal,
    filter: {
      radioId?: string;
      limit?: number;
      cursor?: string;
      callsign?: string;
      source?: string;
    } = {},
  ) {
    const query = await this.query(principal, filter);
    if (filter.cursor) query.before = decodeCursor(filter.cursor);
    const items = await this.repository.packets({
      ...query,
      limit: query.limit + 1,
    });
    const hasMore = items.length > query.limit;
    const visible = items.slice(0, query.limit);
    const last = visible.at(-1);
    return {
      items: visible,
      ...(hasMore && last
        ? {
            nextCursor: Buffer.from(
              JSON.stringify({
                receivedAt: last.receivedAt,
                packetId: last.packetId,
              }),
            ).toString('base64url'),
          }
        : {}),
    };
  }
  async getPacket(
    principal: Principal,
    packetId: string,
  ): Promise<PacketRecord> {
    IdSchema.parse(packetId);
    const packet = await this.repository.packet(principal.instanceId, packetId);
    if (!packet) throw new SignalDockError('NOT_FOUND', 'Packet not found.');
    await this.auth.authorize(principal, 'aprs.read', packet.radioId);
    return packet;
  }
  async listPositions(
    principal: Principal,
    filter: {
      radioId?: string;
      limit?: number;
      callsign?: string;
      source?: string;
      since?: string;
      maxAgeSeconds?: number;
    } = {},
  ): Promise<{
    items: PositionRecord[];
    generatedAt: string;
    maxAgeSeconds: number;
  }> {
    const query = await this.query(principal, filter);
    const maxAge = filter.maxAgeSeconds ?? 1800;
    if (!Number.isInteger(maxAge) || maxAge < 1 || maxAge > 86400)
      throw new SignalDockError(
        'INVALID_ARGUMENT',
        'Position age must be 1–86400 seconds.',
      );
    if (filter.since) TimestampSchema.parse(filter.since);
    const positions = await this.repository.positions({
      ...query,
      ...(filter.since ? { since: filter.since } : {}),
    });
    return {
      items: positions,
      generatedAt: new Date(this.now()).toISOString(),
      maxAgeSeconds: maxAge,
    };
  }
  private async query(
    principal: Principal,
    filter: {
      radioId?: string;
      limit?: number;
      callsign?: string;
      source?: string;
    },
  ): Promise<PacketQuery> {
    const limit = filter.limit ?? 100;
    if (!Number.isInteger(limit) || limit < 1 || limit > 500)
      throw new SignalDockError('INVALID_ARGUMENT', 'Limit must be 1–500.');
    if (
      filter.callsign &&
      !/^[A-Z0-9]{1,6}(?:-(?:[0-9]|1[0-5]))?$/.test(filter.callsign)
    )
      throw new SignalDockError(
        'INVALID_ARGUMENT',
        'Callsign filter is invalid.',
      );
    if (
      filter.source &&
      !['native', 'recording', 'aprs_is'].includes(filter.source)
    )
      throw new SignalDockError(
        'INVALID_ARGUMENT',
        'Packet source filter is invalid.',
      );
    const candidates = filter.radioId
      ? [IdSchema.parse(filter.radioId)]
      : await this.repository.listRadioIds(principal.instanceId);
    const radioIds: string[] = [];
    for (const radioId of candidates) {
      try {
        await this.auth.authorize(principal, 'aprs.read', radioId);
        radioIds.push(radioId);
      } catch (error) {
        if (
          filter.radioId ||
          !(error instanceof SignalDockError) ||
          error.code !== 'FORBIDDEN'
        )
          throw error;
      }
    }
    return {
      instanceId: principal.instanceId,
      radioIds,
      limit,
      ...(filter.callsign ? { callsign: filter.callsign } : {}),
      ...(filter.source ? { source: filter.source } : {}),
    };
  }
}

function decodeCursor(cursor: string): {
  receivedAt: string;
  packetId: string;
} {
  try {
    if (cursor.length > 512) throw new Error();
    const decoded = JSON.parse(
      Buffer.from(cursor, 'base64url').toString('utf8'),
    ) as Record<string, unknown>;
    return {
      receivedAt: TimestampSchema.parse(decoded['receivedAt']),
      packetId: IdSchema.parse(decoded['packetId']),
    };
  } catch {
    throw new SignalDockError('INVALID_ARGUMENT', 'Packet cursor is invalid.');
  }
}
