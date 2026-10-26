# Instance identity and discovery

Implemented: persistent Ed25519 instance identity and public discovery routes.

`identity-store.ts` owns key persistence; `instance.routes.ts` owns the discovery route. Private keys never enter the public response.

Specification: [01-servers-sessions.md](../../../../../docs/specifications/01-servers-sessions.md).
