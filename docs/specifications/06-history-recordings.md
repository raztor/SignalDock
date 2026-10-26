# Conversations and recordings

## History model

A frequency conversation belongs to a radio and a normalized RX frequency in integer Hz. Memory names are labels and may change without splitting history. Repeater TX frequency and signaling are stored as metadata, not assumed equal to RX.

A communication can be received voice, transmitted voice, transmitted TTS, decoded digital content, or an internal note. Audio, transcript revisions, analysis, and decoder results attach to the same entry. A note does not transmit over RF.

## Capture requirements

HIST-01: segment bursts using available radio events and audio activity, with configurable pre-roll and post-roll. Measure clipped starts/ends with test signals.

HIST-02: capture a tuning snapshot and attribution at ingestion. A retune closes or splits a segment; processing completion never assigns it to the currently selected UI frequency.

HIST-03: expose `frequencyAttribution: confirmed | inferred | unknown` with evidence. Dual-watch audio requires a separate attribution test. Unknown origin remains visible and correctable with audit history.

HIST-04: retain source audio where available and a playable derivative. PCM/WAV/FLAC preserves received audio for decoding but cannot reconstruct information already lost through a source codec such as SBC. Compressed voice derivatives may be used according to retention policy.

## User features

Playback, waveform, speed, segment seeking, authorized download, transcript expansion, search, notes, bookmarks, tags, and incident linking. Transcript/decoder jobs update the entry without adding duplicate messages.

Search initially uses PostgreSQL with date/radio/frequency/direction/callsign-candidate/tag/user filters and stable cursor pagination. Speaker identity stays unknown unless supported by explicit evidence; an extracted callsign is not biometric identification.

Include instant replay from a bounded recent buffer and coverage intervals showing when a radio actually monitored a frequency. An unmonitored gap is not evidence that no traffic occurred.

## Retention and integrity

Separate retention for recordings, transcripts, packets, derived analysis, and audit. Support quotas, disk-space status, and documented behavior when storage is full. Incident-held evidence follows an explicit retention policy.

Deleting an artifact invalidates access and cancels dependent work. A late processing result cannot recreate deleted content. Exports and file endpoints enforce the owning instance/radio permissions, including for signed URLs and HTTP range requests.

Record start/end timestamps, media clock references, source codec, content checksum, configuration revision, processing profile, and the known gaps/discontinuities. Human corrections do not overwrite the original transcript.

## Acceptance

One burst/one entry; processing retries without duplication; retune mid-burst; uncertain dual-watch origin; corrected attribution; quota enforcement; deleted input during STT; incident retention; and two instances/radios with colliding IDs. No unauthorized user may fetch a recording by guessing its identifier.
