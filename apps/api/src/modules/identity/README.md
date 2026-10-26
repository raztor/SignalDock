# Users, sessions, and authorization

The identity module provides local administrator bootstrap, Argon2id password hashing, opaque access/refresh credentials, refresh rotation/reuse detection, current-session authorization, per-radio grants, user administration, and local administrator recovery.

## Integration

Compose `SqlIdentityRepository(database, instanceId)` with `IdentityService`, register `identityMigrations` through the shared migration runner, and call `registerIdentityRoutes(app, { prefix, service, cookieOrigin, secureCookies })`. The application composition root owns activation and discovery feature flags.

The service implements `AuthenticationPort` and `NotificationAudiencePort`. `authenticate` and `authorize` inspect current database state; `authorizeUser` checks enabled status/current permissions for explicitly authorized background audiences without fabricating a login session. Configure `onAccessRevoked` to invalidate control/TX/media and device subscriptions after session/user changes.

Use `@node-rs/argon2` 2.2.2. Production passwords use Argon2id with 64 MiB memory, three iterations, and one lane. Access credentials expire after 15 minutes; refresh families expire 30 days after login. Only SHA-256 digests of random tokens are persisted.

## Session transports

- Native and universal cross-origin web clients use bearer access plus body refresh credentials. Native refresh credentials belong in SecureStore; universal web keeps them in memory.
- Same-origin web can use an HttpOnly, SameSite=Strict refresh cookie with an instance-specific name. A separate readable CSRF cookie supports reload recovery; cookie refresh/logout require the matching header and exact configured web origin.
- Cookie credentials are never accepted as authorization for domain API routes. Those routes use bearer access.
- Insecure cookies are accepted only with an explicit HTTP loopback development configuration. A cookie session never returns its refresh credential in JSON.

Administrators manage the instance globally but must explicitly assign their own radio operation grants. Listener grants cannot include tuning/PTT; operators remain limited to assigned radios. Grant/password/status changes revoke existing sessions. The last enabled administrator cannot be disabled or demoted.

## Routes

Under the supplied API prefix: `/auth/bootstrap`, `/auth/login`, `/auth/refresh`, `/auth/logout`, `/auth/sessions`, `/me`, `/admin/users`, role-permission templates, per-user session revocation, and password reset. Public registration is disabled. Authentication endpoints have bounded process-local attempt limiting; multi-process deployments require a shared limiter.

## Local recovery

Stop the API/runtime before administrator recovery. From the repository root, set the instance's database connection and data-directory environment, then run:

```sh
node apps/api/dist/modules/identity/recovery.js --username ADMIN_USERNAME
```

The existing instance identity must be present. The command prompts without echoing the password, updates an enabled administrator only, and revokes that user's sessions. Passwords are not accepted as arguments or environment variables. Recovery is not exposed through HTTP.

## Verification

`apps/api/test/identity.test.ts` exercises real PostgreSQL migrations, concurrent bootstrap/refresh, token reuse revocation, scope/role checks, instance isolation, expiry, password recovery, and cookie/CSRF handling. Set `SIGNALDOCK_TEST_DATABASE_URL` to run the database cases. The password adapter test uses real Argon2id; deterministic password fixtures accelerate the database scenarios.

See the [identity specification](../../../../../docs/specifications/03-identity-administration.md) and [session specification](../../../../../docs/specifications/01-servers-sessions.md).
