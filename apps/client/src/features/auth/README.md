# Authentication

Implemented: local instance login, first-administrator setup, session restoration, logout, expiry/revocation handling, and fenced account/server changes.

The public exports are `SessionController`, `createPlatformAuthOptions`, `useAuthSession`, `LoginScreen`, `BootstrapScreen`, and `SessionListScreen`. Construct one controller for the application shell using the platform options and an `onContextChanging` callback that immediately stops media, PTT, subscriptions, and account-scoped caches. Use `useAuthSession(controller)` to compose authenticated screens from `snapshot.session` (`ClientSession`). Render `LoginScreen` after selecting a server; it includes the bootstrap flow when required.

```ts
const controller = new SessionController({
  ...createPlatformAuthOptions(),
  onContextChanging: stopCurrentWorkspace,
});
await controller.selectServer(baseUrl, discoveryInfo);
await controller.restore();
```

Selection verifies the pinned instance identity before credentials are sent. Every selected context has an abort signal and generation fence; late replies and obsolete authorization callbacks cannot alter a newer account. Refresh rotation is single-flight per controller, and cookie refresh uses Web Locks where available.

Same-origin web deployments use HttpOnly refresh cookies and the instance-scoped readable CSRF proof. Cross-origin web deployments use bearer sessions with refresh tokens held in memory, so page reload requires login. Native builds use Expo SecureStore with device-only accessibility; stored refresh tokens are keyed by the canonical URL, instance ID, and pinned key identity. Access tokens and passwords are never persisted. One most recent account is restored per server identity; multiple distinct instances remain isolated even with identical usernames.

`signOut()` clears local credentials before requesting server revocation. If the server is unreachable, it reports that revocation was not confirmed. `forgetServer(recentServer)` similarly removes only that instance's local credential and verifies the pinned identity before attempting revocation. Wire the server selector's `onServerRemoved` callback to it.

The backend remains authoritative for permissions. Provider-account linking is separate from instance sign-in. Native SecureStore, device interruption, and native media behavior require development-build validation.

Specification: [03-identity-administration.md](../../../../../docs/specifications/03-identity-administration.md).
