import type {
  DatabasePort,
  MigrationDefinition,
  PacketRecord,
  PositionRecord,
} from '@signaldock/contracts';

export const digitalMigrations: readonly MigrationDefinition[] = [
  {
    id: '045_digital',
    sql: `
CREATE TABLE IF NOT EXISTS sd_digital_packets (
  instance_id uuid NOT NULL, packet_id uuid NOT NULL, radio_id uuid NOT NULL,
  received_at timestamptz NOT NULL, source text NOT NULL CHECK(source IN ('native','recording','aprs_is')),
  raw_frame_base64 text, raw_text text, frequency_hz bigint,
  attribution text NOT NULL CHECK(attribution IN ('confirmed','inferred','unknown')),
  parser_version text NOT NULL, callsign text, destination text, path jsonb NOT NULL,
  kind text NOT NULL, parsed jsonb, fingerprint text NOT NULL,
  PRIMARY KEY(instance_id, packet_id), CHECK(frequency_hz IS NULL OR (frequency_hz > 0 AND frequency_hz <= 9007199254740991))
);
CREATE INDEX IF NOT EXISTS sd_digital_packets_recording_source ON sd_digital_packets(instance_id,((parsed->'recording'->>'artifactId'))) WHERE source='recording';
CREATE INDEX IF NOT EXISTS sd_digital_packets_radio_time ON sd_digital_packets(instance_id,radio_id,received_at DESC,packet_id DESC);
CREATE TABLE IF NOT EXISTS sd_aprs_positions (
  instance_id uuid NOT NULL, position_id uuid NOT NULL, packet_id uuid NOT NULL, radio_id uuid NOT NULL,
  callsign text NOT NULL, lat double precision NOT NULL CHECK(lat BETWEEN -90 AND 90),
  lon double precision NOT NULL CHECK(lon BETWEEN -180 AND 180), symbol text,
  received_at timestamptz NOT NULL, source text NOT NULL,
  PRIMARY KEY(instance_id, position_id),
  FOREIGN KEY(instance_id,packet_id) REFERENCES sd_digital_packets(instance_id,packet_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS sd_aprs_positions_station_time ON sd_aprs_positions(instance_id,radio_id,callsign,received_at DESC,position_id DESC);
CREATE TABLE IF NOT EXISTS sd_digital_decoder_runs (
  instance_id uuid NOT NULL, run_id uuid NOT NULL, radio_id uuid NOT NULL, artifact_id uuid NOT NULL,
  mode text NOT NULL CHECK(mode IN ('AFSK1200','DTMF')), state text NOT NULL, requested_by uuid NOT NULL,
  result jsonb, error text, created_at timestamptz NOT NULL, completed_at timestamptz,
  PRIMARY KEY(instance_id,run_id)
);`,
  },
];

export interface PacketQuery {
  instanceId: string;
  radioIds: string[];
  limit: number;
  before?: { receivedAt: string; packetId: string };
  callsign?: string;
  source?: string;
}
export interface DigitalRepository {
  ingest(packet: PacketRecord, fingerprint: string): Promise<boolean>;
  listRadioIds(instanceId: string): Promise<string[]>;
  packets(query: PacketQuery): Promise<PacketRecord[]>;
  packet(instanceId: string, packetId: string): Promise<PacketRecord | null>;
  positions(query: PacketQuery & { since?: string }): Promise<PositionRecord[]>;
}

function date(value: unknown): string {
  return value instanceof Date
    ? value.toISOString()
    : new Date(String(value)).toISOString();
}
function packetRow(row: Record<string, unknown>): PacketRecord {
  return {
    packetId: String(row['packet_id']),
    instanceId: String(row['instance_id']),
    radioId: String(row['radio_id']),
    receivedAt: date(row['received_at']),
    source: row['source'] as PacketRecord['source'],
    attribution: row['attribution'] as PacketRecord['attribution'],
    parserVersion: String(row['parser_version']),
    path: row['path'] as string[],
    kind: String(row['kind']),
    ...(row['raw_frame_base64'] === null
      ? {}
      : { rawFrameBase64: String(row['raw_frame_base64']) }),
    ...(row['raw_text'] === null ? {} : { rawText: String(row['raw_text']) }),
    ...(row['frequency_hz'] === null
      ? {}
      : { frequencyHz: Number(row['frequency_hz']) }),
    ...(row['callsign'] === null ? {} : { callsign: String(row['callsign']) }),
    ...(row['destination'] === null
      ? {}
      : { destination: String(row['destination']) }),
    ...(row['parsed'] === null
      ? {}
      : { parsed: row['parsed'] as Record<string, unknown> }),
    ...(row['position_data'] && typeof row['position_data'] === 'object'
      ? {
          position: positionRow(
            row['position_data'] as Record<string, unknown>,
          ),
        }
      : {}),
  };
}
function positionRow(row: Record<string, unknown>): PositionRecord {
  return {
    positionId: String(row['position_id']),
    packetId: String(row['packet_id']),
    instanceId: String(row['instance_id']),
    radioId: String(row['radio_id']),
    callsign: String(row['callsign']),
    lat: Number(row['lat']),
    lon: Number(row['lon']),
    receivedAt: date(row['received_at']),
    source: row['source'] as PositionRecord['source'],
    ...(row['symbol'] === null ? {} : { symbol: String(row['symbol']) }),
  };
}

export class PostgresDigitalRepository implements DigitalRepository {
  constructor(private readonly database: DatabasePort) {}
  async ingest(packet: PacketRecord, fingerprint: string): Promise<boolean> {
    return this.database.transaction(async (transaction) => {
      const inserted = await transaction.query(
        `INSERT INTO sd_digital_packets
        (instance_id,packet_id,radio_id,received_at,source,raw_frame_base64,raw_text,frequency_hz,attribution,parser_version,callsign,destination,path,kind,parsed,fingerprint)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14,$15::jsonb,$16)
        ON CONFLICT(instance_id,packet_id) DO NOTHING RETURNING packet_id`,
        [
          packet.instanceId,
          packet.packetId,
          packet.radioId,
          packet.receivedAt,
          packet.source,
          packet.rawFrameBase64 ?? null,
          packet.rawText ?? null,
          packet.frequencyHz ?? null,
          packet.attribution,
          packet.parserVersion,
          packet.callsign ?? null,
          packet.destination ?? null,
          JSON.stringify(packet.path),
          packet.kind,
          packet.parsed ? JSON.stringify(packet.parsed) : null,
          fingerprint,
        ],
      );
      if (!inserted.rowCount) return false;
      const position = packet.position;
      if (position)
        await transaction.query(
          `INSERT INTO sd_aprs_positions
        (instance_id,position_id,packet_id,radio_id,callsign,lat,lon,symbol,received_at,source)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [
            position.instanceId,
            position.positionId,
            position.packetId,
            position.radioId,
            position.callsign,
            position.lat,
            position.lon,
            position.symbol ?? null,
            position.receivedAt,
            position.source,
          ],
        );
      return true;
    });
  }
  async listRadioIds(instanceId: string): Promise<string[]> {
    const result = await this.database.query(
      'SELECT DISTINCT radio_id FROM sd_digital_packets WHERE instance_id=$1',
      [instanceId],
    );
    return result.rows.map((row) => String(row['radio_id']));
  }
  async packets(query: PacketQuery): Promise<PacketRecord[]> {
    const result = await this.database.query(
      `SELECT * FROM sd_digital_packets WHERE instance_id=$1 AND radio_id=ANY($2::uuid[])
      AND ($3::text IS NULL OR callsign=$3) AND ($4::text IS NULL OR source=$4)
      AND ($5::timestamptz IS NULL OR (received_at,packet_id)<($5::timestamptz,$6::uuid))
      ORDER BY received_at DESC,packet_id DESC LIMIT $7`,
      [
        query.instanceId,
        query.radioIds,
        query.callsign ?? null,
        query.source ?? null,
        query.before?.receivedAt ?? null,
        query.before?.packetId ?? null,
        query.limit,
      ],
    );
    return result.rows.map(packetRow);
  }
  async packet(
    instanceId: string,
    packetId: string,
  ): Promise<PacketRecord | null> {
    const result = await this.database.query(
      `SELECT packet.*,to_jsonb(position) AS position_data FROM sd_digital_packets packet
       LEFT JOIN sd_aprs_positions position ON position.instance_id=packet.instance_id AND position.packet_id=packet.packet_id
       WHERE packet.instance_id=$1 AND packet.packet_id=$2`,
      [instanceId, packetId],
    );
    return result.rows[0] ? packetRow(result.rows[0]) : null;
  }
  async positions(
    query: PacketQuery & { since?: string },
  ): Promise<PositionRecord[]> {
    const result = await this.database.query(
      `SELECT * FROM sd_aprs_positions WHERE instance_id=$1 AND radio_id=ANY($2::uuid[])
      AND ($3::text IS NULL OR callsign=$3) AND ($4::text IS NULL OR source=$4)
      AND ($5::timestamptz IS NULL OR received_at >= $5)
      ORDER BY received_at DESC,position_id DESC LIMIT $6`,
      [
        query.instanceId,
        query.radioIds,
        query.callsign ?? null,
        query.source ?? null,
        query.since ?? null,
        query.limit,
      ],
    );
    return result.rows.map(positionRow);
  }
}

/** Run under the history communication lock before tombstoning its recording source. */
export async function removeDigitalRecordingDerivatives(
  transaction: DatabasePort,
  instanceId: string,
  artifactId: string,
): Promise<void> {
  await transaction.query(
    `DELETE FROM sd_digital_packets WHERE instance_id=$1 AND source='recording' AND parsed->'recording'->>'artifactId'=$2`,
    [instanceId, artifactId],
  );
  // Positions cascade from packet evidence; decoder results also contain copies of raw frames.
  await transaction.query(
    'DELETE FROM sd_digital_decoder_runs WHERE instance_id=$1 AND artifact_id=$2',
    [instanceId, artifactId],
  );
}
