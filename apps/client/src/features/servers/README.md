# Server connections

Implemented: server URL entry, discovery, protocol and pinned-identity checks, and recent-server persistence/removal.

`ServerConnectionScreen` accepts optional `onServerSelected(baseUrl, info)` and `onServerRemoved(recentServer)` callbacks. The shell connects these to `SessionController.selectServer` / `restore` and `forgetServer`. Recent entries contain discovery metadata only; session credentials are stored through the separate authentication platform adapter.

Selection invokes the callback only for servers advertising local authentication. Removing a server clears its local session through the callback, attempts scoped revocation, and removes recent metadata even when the server is offline. The UI reports unconfirmed revocation. Switching instances clears the active workspace before the next account is restored.

Screens live in `screens/`; the recent-metadata storage adapter lives in `data/`.

Specification: [01-servers-sessions.md](../../../../../docs/specifications/01-servers-sessions.md).
