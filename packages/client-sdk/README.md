# client-sdk

Prefix-aware discovery, protocol and saved-identity checks, and recent-server persistence live in `src`. Platform storage is injected by clients; this package does not import React Native or browser storage. Keep accounts, sessions, and credentials isolated by instance as those features are implemented.

See the [repository layout](../../docs/architecture/repository-layout.md) for dependency boundaries.
