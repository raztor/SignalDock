# Radio runtime

`src/runtime` owns the registry, connection supervision, session-bound control leases, resource-group exclusion, memory/tuning dispatch, and the reservation seam consumed by the TX supervisor. `src/simulation` creates two independent fixtures. `src/index.ts` is the package boundary.

Run `npm run simulate` from the root. The API radio module persists explicit radio configuration through the database port and enforces authentication before runtime admission. Reconnect invalidates grants and never replays a command or transmission. An uncertain TX reservation remains locked until the dedicated TX supervisor confirms physical idle.

See [radio implementation](../../docs/implementation/radios.md) for deployment boundaries, routes, tests, and acceptance gaps.
