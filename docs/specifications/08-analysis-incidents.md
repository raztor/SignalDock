# Message analysis, emergencies, and incidents

## Independent tasks

A completed transcript may trigger separately configured callsign extraction, entity/place extraction, summarization, and emergency detection. Each task has its own input schema, output schema, version, processing profile, and selected connector. Tasks may be disabled independently or implemented locally.

Local keyword/expression rules remain available without a remote provider. Enriched analysis records its provenance and complements those rules. A future task is added through the task registry and connector SDK, not by adding vendor-specific code to the history API.

## Evidence and uncertainty

- Findings reference transcript revisions, communication IDs, and audio segments where available.
- A callsign is a candidate: it may be misrecognized or name someone mentioned rather than the speaker. Manual confirmation has separate status.
- A summary is a derived view, never a replacement for source text or proof of omitted facts.
- A spoken location does not become a confirmed APRS position.
- Validate structured output and evidence references. Empty/uncertain/error results are valid; never force a callsign or emergency classification.
- Radio speech, transcripts, prompts embedded in received messages, and provider output are untrusted data. They cannot issue shell commands, change permissions, or operate PTT.

## Emergency workflow

EMR-01: configurable rules by radio, frequency, expression, time, and bounded surrounding context.

EMR-02: priority and reasons visible with evidence and original audio. Provider scores require calibration before becoming shared thresholds.

EMR-03: incident states `new`, `acknowledged`, `in_progress`, `resolved`, `dismissed`, with owner, notes, timestamps, and audit.

EMR-04: deduplicate/aggregate related findings; revised transcripts can update an incident without erasing earlier decisions.

EMR-05: notification delivery and human acknowledgement are different states. The backend records acknowledgement.

EMR-06: no automatic RF transmission or external emergency contact. Any future action workflow needs its own explicit policy and authorization.

## Incident record

Link communications, audio, transcript revisions, packets, confirmed positions, notes, and decisions. Support explicit retention holds and an export containing original references/times. Access combines incident and source-radio permissions.

## Acceptance

Evaluate false positives and missed cases on labeled samples; unsupported/invented evidence; third-party callsign mentions; hostile instructions inside radio text; provider outage; duplicate jobs; corrected source text; and summaries that attempt to reference deleted or unauthorized communications. Present detection as review assistance, not complete emergency coverage.
