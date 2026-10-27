# Radio dashboard

`RadioDashboardScreen` lists assigned radios, confirmed state, capability-based tuning, memory recall, and session-bound control ownership. Administrators can configure installed connectors and inspect configuration independently of operational grants.

Selecting a radio must not itself retune hardware. Render capability-based controls using generic DTOs.

Requests and polling belong to the selected instance and are cancelled on session/radio changes. Frequency inputs convert decimal MHz to integer Hz without rounding. Native builds use `expo-crypto` for secure operation IDs. Physical browser and native acceptance are separate from TypeScript verification.

Specification: [04-radio-runtime.md](../../../../../docs/specifications/04-radio-runtime.md).
