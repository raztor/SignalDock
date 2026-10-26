# Digital decoding and APRS implementation

## Delivered boundaries

- `services/digital-decoders`: bounded APRS/AX.25 parser, recorded Bell 202 AFSK1200 decoder, DTMF decoder, cancellable child-process runner, and deterministic synthetic fixtures.
- `apps/api/src/modules/aprs`: instance/radio-scoped repositories, migration `045_digital`, packet/position routes, idempotent recording jobs, and fenced terminal result publication.
- `apps/client/src/features/aprs`: instance-scoped packet/position/recording workflows, web MapLibre adapter, and native list fallback.

No decoder receives radio control, PTT, user file paths, shell commands, processing credentials, or cloud endpoints. There is no RF transmission, IGate, digipeating, or automatic APRS-IS connection. Native packet ingestion is generic and requires a driver capability; VGC support has not been asserted.

## Integration requirements

Add the decoder workspace to TypeScript project references and the API's dependencies. Add `maplibre-gl` 6.16.0 and `expo-crypto` 58.0.7 to the Expo application. Apply migration 045 after the shared/history foundations. Compose routes with the instance authentication service. Register `digital.decode` on the shared job worker with private storage and an available-recording context resolver. Terminal `execution.commit` must validate source revision/deletion and active job/cancellation/deadline in the same transaction as writes.

The public packet/position DTOs come from `@signaldock/contracts`; decoder job views and audio result formats belong to this module. The frontend consumes the shared API request/session helpers and accepts an optional configured HTTPS map style. Default mapping contacts no tile service. Compose the history `onDeleteSource` callback with `removeDigitalRecordingDerivatives` for each source artifact so already-stored derived evidence follows source deletion.

## Observed validation

The following checks passed locally using Node 24 and PostgreSQL 18.4 in unique test schemas:

- TypeScript backend compilation.
- Real Bell 202 synthetic WAV decoding at 16,000, 22,050, 32,000, and 48,000 Hz, including CRC verification and corrupted-frame rejection.
- Real DTMF synthetic audio with timed output and silence/single-tone rejection.
- An actual FFmpeg SBC encode/decode round trip of the synthetic packet audio followed by successful decoding. This is a separate compressed-audio fixture, not live Bluetooth evidence.
- Child process cancellation/deadline handling and invalid WAVE rejection.
- PostgreSQL packet isolation across instances/radios, repeated source IDs, pagination, original malformed/ambiguous evidence, recording scheduling/result transactions, and rejected terminal commits.
- Pure map-model station scope, freshness, and source-separated tracks.

Reproduce with `vitest run services/digital-decoders/test apps/api/test/aprs.test.ts apps/client/src/features/aprs/map-model.test.ts`. Set `TEST_DATABASE_URL` to an expendable test PostgreSQL database for SQL checks; absent configuration skips them explicitly. The SBC test requires local FFmpeg and skips explicitly when unavailable.

## Remaining acceptance gates

Physical packet decoding from VR-N7500 Bluetooth recordings, Linux ARM64 runtime deployment, WebGL interaction in the integrated web application, native interactive mapping, and native device acceptance remain unverified. Native VGC packet feed capability is not advertised. Current APRS support excludes compressed positions, Mic-E, objects/items, altitude/course interpretation, SSTV, and digital voice. Unsupported frames retain evidence without fabricated coordinates. Input audio must be complete mono PCM16 WAVE; general compressed-codec transcoding is outside this decoder boundary.
