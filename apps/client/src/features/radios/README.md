# Radio dashboard

`RadioDashboardScreen` reads everything from `useStation()` (`features/station`): a grid of `RadioFaceplate` cards, then the selected radio's hero faceplate, control ownership (take / release), `TuningPanel` (digit dial, step, mode, TX offset, band bar, Apply / Revert), `MemoryGrid` (recall, confirmed overwrite) and live audio (right rail on wide layouts, inline otherwise). `RadioConfigurationPanel` lets administrators configure installed connectors independently of operational grants.

Selecting a radio must not itself retune hardware. Render capability-based controls using generic DTOs.

Requests and polling belong to the selected instance and are cancelled on session/radio changes. Frequency math uses integer Hz only (`station-model.ts`, `components/tuning-model.ts`). Native builds use `expo-crypto` for secure operation IDs. Physical browser and native acceptance are separate from TypeScript verification.

Specification: [04-radio-runtime.md](../../../../../docs/specifications/04-radio-runtime.md).
