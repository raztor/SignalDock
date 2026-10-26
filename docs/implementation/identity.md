# Identity implementation handoff

The backend exports `IdentityService`, `SqlIdentityRepository`, `identityMigrations`, `registerIdentityRoutes`, and `createArgon2idHasher` from its domain index. Apply migration `010_identity` after the shared foundation migration. The production repository scopes every query and foreign key to its instance.

Dependencies: `@node-rs/argon2` 2.2.2 and `@signaldock/database`. Root composition supplies the actual database, persistent instance ID, setup token (at least 24 characters), permitted same-origin cookie origin, and revocation callback. Bootstrap creates no implicit radio permissions.

Access/session revocation is database-authoritative, and refresh reuse is committed before its error is returned. Radio/PTT/media invalidation must be connected by composition; the module never contacts a radio itself. Global `instance.admin` does not confer operational radio permission.

The frontend handoff is described below when its controller/screens are integrated. Physical radio, store publication, and production Linux device acceptance are outside this module's local verification.
