# Radio dashboard

`RadioDashboardScreen` reads everything from `useStation()` (`features/station`): a grid of `RadioFaceplate` cards, then the selected radio's hero faceplate, control ownership (take / release), `TuningPanel` (digit dial, step, mode, TX offset, band bar, Apply / Revert), `MemoryGrid` (recall, confirmed overwrite) and live audio (right rail on wide layouts, inline otherwise). Administrators get `RadioConfigurationList` (cards with live status) and `RadioSetupWizard` (Driver → Identity & connection → Settings via `SchemaForm` or Advanced JSON → Review & save → Access), which configure installed drivers independently of operational grants. The wizard's pure logic lives in `radio-setup-model.ts`. Administrators also see the `SetupChecklist` (from `features/admin`) at the top: its "Configure a radio" action expands the configuration section, opens a new-radio wizard (`RadioConfigurationList` `createRequest`) and scrolls to it. `RadioDashboardScreen({ onOpenAccess? })` threads the shell's Users & access navigation to the checklist and to the wizard's Access step; without it both explain where to go.

Selecting a radio must not itself retune hardware. Render capability-based controls using generic DTOs.

Requests and polling belong to the selected instance and are cancelled on session/radio changes. Frequency math uses integer Hz only (`station-model.ts`, `components/tuning-model.ts`). Native builds use `expo-crypto` for secure operation IDs. Physical browser and native acceptance are separate from TypeScript verification.

Specification: [04-radio-runtime.md](../../../../../docs/specifications/04-radio-runtime.md).
