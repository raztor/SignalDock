# Conversations and recordings

`registerHistoryRoutes(app, {auth, history})` is mounted by application composition under the instance's `/api/v1` prefix. All endpoints require fresh authentication. List queries filter authorized radio scopes before pagination; every individual communication and recording request checks its radio permission again. Playback uses `history.read`; explicit download requires `recording.export`; corrections and notes use `history.write`; deleting communications and changing retention holds require instance administration.

Routes cover frequency conversations, cursor-paginated communications, transcript/note/tag search, station notes, immutable human transcript revisions, audited metadata corrections, coverage intervals, and deletion. `GET /recordings/:id` returns private recording bytes with single HTTP byte-range support and HTTP416 for unsatisfiable ranges. Credentials remain in request headers. Responses are not cacheable; the artifact directory is never a static mount.

Persistence, source locks, deletion, retention, and PCM segmentation live in `@signaldock/history`. Wire `HistoryCaptureRecorder.onFinalized` to configured processing jobs after commit. Audio gaps remain visible, and optional processing must reject unavailable recordings. Schedule the worker's history maintenance handler for artifact cleanup and configured retention cutoffs. Source-bound work must use terminal `execution.commit` fencing.

Real PostgreSQL 18 integration tests cover API scopes, playback ranges, stale edits, deletion, and late transcript suppression. They use isolated schemas. Browser/native physical playback and live radio capture are separate rollout acceptance gates.

Specification: [06-history-recordings.md](../../../../../docs/specifications/06-history-recordings.md).
