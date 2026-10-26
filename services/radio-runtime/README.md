# Radio runtime

`src/runtime` owns the implemented in-memory registry, leases, resource-group exclusion, and tuning dispatch. `src/simulation` creates the two-radio fixture and the simulation CLI. `src/index.ts` is the package export boundary.

Run `npm run simulate` from the root. Persistent configuration, driver supervision/transport, full TX supervision, and physical conformance remain later work. User authentication is enforced by the backend before this runtime is exposed to clients.
