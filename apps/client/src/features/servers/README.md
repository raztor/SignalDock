# Server connections

Implemented: server URL entry, discovery, protocol and pinned-identity checks, and recent-server persistence/removal.

`ServerConnectionScreen` accepts optional `onServerSelected(baseUrl, info)` and `onServerRemoved(recentServer)` callbacks. The shell connects these to `SessionController.selectServer` / `restore` and `forgetServer`. Recent entries contain discovery metadata only; session credentials are stored through the separate authentication platform adapter.

Selection invokes the callback only for servers advertising local authentication. Removing a server clears its local session through the callback, attempts scoped revocation, and removes recent metadata even when the server is offline. The UI reports unconfirmed revocation. Switching instances clears the active workspace before the next account is restored.

Recent stations render as cards with live health (`use-station-health.ts`: the same discovery request and pinned-identity check as selection, 4 s timeout) and the last-used time. Address entry adds `https://` when the scheme is missing (`http://` only for loopback) and validates inline with the SDK's rules (`server-model.ts`).

Administrators get "Share station" (`ShareStationButton`, `components/ShareStation.tsx`; the shell renders it in the wide sidebar footer and in More → Station & account, and it renders nothing for other roles): a QR code of the station address drawn with react-native-svg from the `qrcode` encoder core (`qr-model.ts`), plus Copy link (web) or the share sheet (native). Native builds offer "Scan QR" (`components/QrScanButton.native.tsx`, `expo-camera`, loaded lazily and hidden when the camera module is missing); web shows no scan button. Scanned codes only fill in the address; connecting stays an explicit step.

Screens live in `screens/`, components in `components/`, and the recent-metadata storage adapter lives in `data/`. `index.ts` is the feature's public entry point (screen, share button, QR, cards, health hook, `server-model`).

Specification: [01-servers-sessions.md](../../../../../docs/specifications/01-servers-sessions.md).
