# Communication history

`HistoryScreen` accepts the common `FeatureScreenProps` and shows frequency conversations, radio filters, search, cursor pagination, station notes, private recording playback, transcripts with revision/provenance, correction controls, and administration holds/deletion. Unknown frequency attribution is explicit. Only the tuned source is monitored; the UI never implies simultaneous scanning of all conversations.

Web playback fetches with the selected instance's authorization header, creates a temporary object URL, and stops/releases it on session change or unmount. Native development builds use the SDK58-compatible `expo-audio` adapter with authenticated source headers. No token appears in a URL. Native playback still requires physical development-build acceptance; background playback is not enabled here.

The workspace remounts when the instance or credentials change, cancelling reads and discarding prior cached communications. Client visibility is advisory; the backend authorizes each operation. Application composition owns navigation registration. API and client TypeScript checks pass; application-level browser verification is performed after composition.

Specification: [06-history-recordings.md](../../../../../docs/specifications/06-history-recordings.md).
