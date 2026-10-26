# Digital decoding and APRS

This module stores bounded, original packet evidence and supported APRS positions. Public endpoints require an authenticated instance session and radio-scoped `aprs.read`. Recording jobs additionally require `history.read`; cancelling another user's job requires `processing.manage`.

## Composition

Apply `digitalMigrations` (`045_digital`) through the shared migration runner. Construct `PostgresDigitalRepository`, then `AprsService(repository, auth)`, and register `registerAprsRoutes(app, { prefix: '/api/v1', auth, service, decoding })`.

`AprsService.ingest(ReceivedPacket)` is an internal driver/worker entry point. It accepts an AX.25 frame or TNC2 line, original receive time, source, radio, and frequency attribution. There is deliberately no public packet injection endpoint. Drivers must advertise an actual native packet capability before wiring a native feed; the VGC integration does not currently advertise one. Source `aprs_is` is reserved for an independently configured receive connector; this module does not open an APRS-IS connection.

For recording jobs construct `DigitalDecodingService({ database, auth, queue, resolveRecording })`. Register `createDigitalDecodeHandler({ database, storage, resolveRecording })` under `digital.decode` on the shared queue. The resolver returns `null` for deleted or unavailable recordings and supplies the original communication ID/revision, radio, receive time, and frequency context. Scheduling and metadata share a transaction. CPU/subprocess work runs outside the terminal `execution.commit` transaction; final packet and result writes require its active-attempt, source-revision, cancellation, and deadline guard.

Wire `removeDigitalRecordingDerivatives(transaction, instanceId, artifactId)` into the history `onDeleteSource` callback for every artifact before its source is tombstoned. It deletes derived packet/position evidence and decoder result copies in that same locked transaction. Pending jobs cannot recreate them because terminal source guards reject deleted inputs.

## Routes

| Method | Route            | Behavior                                                                      |
| ------ | ---------------- | ----------------------------------------------------------------------------- |
| GET    | `/packets`       | Scoped keyset-paginated evidence; radio, callsign, source filters.            |
| GET    | `/packets/:id`   | Original text/frame, parser result, supported position, provenance.           |
| GET    | `/positions`     | Received points with server time and stale-age policy; optional time window.  |
| POST   | `/decodings`     | Idempotent operation UUID, existing recording artifact, `AFSK1200` or `DTMF`. |
| GET    | `/decodings/:id` | Queue state, bounded results, or failure.                                     |
| DELETE | `/decodings/:id` | Cancel a decoder job.                                                         |

No route tunes a radio, keys PTT, transmits, forwards packets, or digipeats.

## Evidence and limits

Instance IDs are part of primary keys and packet/position foreign keys. SQL values are parameterized. Repeated source event IDs are idempotent; separate receptions of identical payloads remain distinct. Malformed, ambiguous, and unsupported input retains its original evidence. Positions are emitted only for supported uncompressed APRS coordinates, never inferred from a callsign. Recording-derived packet timestamps use the recording start plus decoded sample offset, and preserve uncertain frequency attribution.

Decoder jobs read at most 16 MiB plus one byte from private storage, reject oversized artifacts, and use a bounded child process. See [decoder capabilities and isolation](../../../../../services/digital-decoders/README.md). Supported input is complete mono PCM16 WAVE, 8–48 kHz, up to 120 seconds. Arbitrary codecs, compressed APRS/Mic-E, SSTV, digital voice, RF transmission, and IGate operation are unsupported. Recorded SBC round-trip fixtures pass; actual received Bluetooth audio decoding remains a physical acceptance gate.

## Verification

Run `vitest run apps/api/test/aprs.test.ts` with `TEST_DATABASE_URL` pointing to a test PostgreSQL database. Each run creates and drops a unique schema. Tests verify actual SQL isolation, pagination, evidence preservation, atomic scheduling, real decoder results, and rejection of cancelled/deleted-source commits. Queue and source-guard services are fixtures here; queue locking is verified by the shared queue's integration suite.

Specification: [09-digital-aprs.md](../../../../../docs/specifications/09-digital-aprs.md).
