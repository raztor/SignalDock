# Frontend design system

## Scope and audit

The client is a self-hosted radio workspace, built with Expo 58.0.22, React 19.3, React Native 0.88 and strict TypeScript. One application entry point composes independent feature modules. Authentication, server identity checks, control leases, media supervision, provider integration and radio permissions belong to their existing controllers and services.

The audit covered server discovery, sign-in, first-administrator setup, radios and memories, live audio/PTT, communication history and playback, incidents, APRS/decoding, notifications, processing, session management and user administration. There is no existing logo/image asset library. A small line-based radio mark and a consistent set of functional icons establish identity without decorative imagery.

The previous presentation mixed dark authentication and feature pages with a light radio dashboard and audio panel. Screens defined their own colors, typography and actions; navigation wrapped eight buttons above the content; audio created two competing scroll areas on small displays; and setup forms displaced operational content. These findings informed the implementation rather than preserving those layouts.

## Foundations

`packages/ui/src/tokens.ts` owns semantic colors, typography, spacing, radius, layout and motion conventions. Light uses stone-colored backgrounds, white surfaces and deep green primary actions. Dark uses mineral green-black backgrounds and restrained pale green actions. Amber is reserved for uncertainty; red is reserved for errors and destructive actions. No gradients, decorative shadows or blur are used.

| Foundation    | Convention                                                                                             |
| ------------- | ------------------------------------------------------------------------------------------------------ |
| Text          | System proportional text; tabular monospace for radio frequencies                                      |
| Type scale    | Caption 12, label 14, body 15, heading 18, page title 28; display 36 only for connection introduction  |
| Spacing       | 4, 8, 12, 16, 24, 32, 48 points                                                                        |
| Radius        | 4, 8, 12 points, according to hierarchy                                                                |
| Touch targets | At least 48 points in shared actions and setting rows                                                  |
| Content       | 1120 maximum content width; 480 maximum form width                                                     |
| Responsive    | Compact composition below 720; station sidebar and optional audio rail from 1100                       |
| Icons         | Functional 20-point line icons, 24-point brand mark; decorative icons hidden from assistive technology |
| Motion        | No custom animated navigation; native control feedback; web transitions disabled under reduced motion  |

`ThemeProvider` follows the system by default and persists explicit system/light/dark preference through device storage. The preference loads before the feature tree mounts. `createStyles` and `useFeatureStyles` create theme-bound recipes without mutable global colors. Text continues to respect system scaling. Status messages retain text alongside color.

Color verification covers primary and secondary text, primary/status colors on background, surface, elevated and selected surfaces, plus filled primary actions. Minimum measured ratios: light **5.01:1**, dark **4.85:1**; filled actions **7.13:1** and **9.27:1**, respectively. Disabled controls are excluded from those text-contrast assertions.

## Shared components

- `Text`, `Heading`, `TextInput`: semantic text, native editing, consistent defaults, focus indication and theme-aware placeholder/selection colors.
- `Pressable`, `Button`/`Action`: shared pressed, focused, disabled, selected and loading behavior. Primary, secondary, quiet and destructive variants. The web adapter explicitly maps native accessibility state to ARIA so checked, selected, expanded and busy states remain available across platforms. PTT retains its dedicated press-in/press-out handling.
- `Panel`, `Divider`, `ScrollView`, `FormLayout`: composition and keyboard-aware scrolling with safe-area handling at the application boundary.
- `SettingToggle` and `Checkbox`: the official universal `@expo/ui` controls inside its `Host`, using SwiftUI on iOS, Compose on Android and the official web implementation. The host receives the active theme and primary seed color.
- `Disclosure`: optional configuration and provenance remain available without occupying the entire operational view. Its contents stay mounted so collapsing does not erase edits. It is uncontrolled by default; `open` / `onOpenChange` let a screen expand it on request (the setup checklist opens the radio configuration section this way).
- `EmptyState`, `ErrorState`, `LoadingState`, `ConfirmDialog`, `ConfirmButton`: useful feedback and explicit confirmation for forgetting a station, revoking sessions or provider connections, and changing account access or passwords.
- `FeatureView`: preserves visited view state, exposes active/inactive context to playback, and contains a rendering failure to its destination with a retry action.

### Visual controls (`packages/ui/src/controls.tsx`)

These replace free-text fields wherever a value comes from a known set. All are theme-token only, keep a 48-point target for primary controls (dense chips 36 points with hit slop), and never signal state by colour alone.

- `SegmentedControl`: radio-group semantics (`radiogroup` / `radio` + `checked`), always one line: narrow windows tighten the padding and, if the options still do not fit, the row scrolls horizontally and keeps the checked or focused option in view (arrow-key roving focus is unchanged). `compact` size for dense rows. Use it for 2–5 mutually exclusive choices: tuning step, mode, TX offset, role, cooldown, section switchers.
- `Chip`, `ChipGroup`, `ChipInput`: a chip is a static label, a button, or (with `selected`) a checkbox with a check mark. `dashed` marks inferred or unconfirmed values (frequency attribution) and `monospace` frequencies. `ChipInput` creates chips on Enter, comma or blur, removes the last one with Backspace, de-duplicates case-insensitively and shows validation inline (pure logic in `chip-input-model.ts`).
- `StatusIndicator`: a distinct SVG shape plus text for every tone — filled circle (ok), dashed amber ring (pending), amber triangle (warning), red diamond (error), hollow ring (off) and dotted ring with a centre dot (unknown). The optional pulse is an opacity change skipped under reduced motion. Unknown is never drawn as idle.
- `Badge`: short neutral / primary / warning / error labels (verification, Local / Cloud, Simulated, Unread).
- `Stepper`: numbered wizard progress; done steps show a check on the selected tint, the current step is filled with the primary colour and named for assistive technology. The setup checklist uses the same marks.
- `NumberField`: numeric text plus ± buttons that disable at the bounds, optional unit suffix, clamped on blur.
- `Overlay`: centred or top-placed modal surface with a scrim, Escape / back to close and an accessible label; used by the command palette, close-incident sheet, time-zone picker and Share station. `ConfirmDialog` stays the confirmation surface for destructive or overwriting actions.
- `useReducedMotion()`: reads the platform setting; every animation in the redesign is optional and short.

### Feedback: toasts

`ToastProvider` (inside `ThemeProvider`, once per app) renders a polite live-region stack: full width at the bottom on compact layouts above the bottom dock, centred at the bottom on wide layouts so they never cover the primary actions screens and wizards place at the bottom-right, safe-area aware, at most three. `useToast().show({ message, tone, action? })` auto-dismisses after 4 s (errors 7 s, toasts with an action 15 s) and is a no-op without a provider, so isolated screens never crash. Toasts confirm results; errors that need a fix stay inline next to the control that failed.

### Settings from a schema: `SchemaForm`

`SchemaForm` renders a restricted JSON-Schema subset from drivers and processing connectors: `string` (enum → SegmentedControl up to five values, else chips; `format: 'uri'`; `x-secret` → secure entry; `x-credential-ref` → a labelled credential reference), `integer` / `number` (`NumberField` with bounds, `x-step`, `x-unit`), `boolean` (`SettingToggle`) and string arrays (`ChipInput`). Object arrays render only when `x-ui: 'hidden'`; any other shape shows "Edit this setting in Advanced JSON". `validateSchemaValue`, `withSchemaDefaults` and the number helpers are pure (`schema-form-model.ts`, unit tested). Screens that use it always offer an Advanced JSON editor with live validation as the fallback, behind the same `Form` / `Advanced JSON` segmented switcher in the radio setup wizard and processing editors: it is always shown, the `Form` option is disabled (with the reason in its accessible label) when the driver or provider does not describe its settings, and the JSON editor uses the monospace frequency font at 13 points.

Use shared recipes for common presentation. Local styles express domain layout and use tokens; business logic does not belong in the presentation package. Do not add unused generic controls or new boolean-driven component families.

## Feature patterns

These compositions live in feature folders, not in `packages/ui`, because they carry domain rules.

### Radio operation (Stage 1)

- **Station state**: `StationProvider` (`features/station`) owns the radio list, live snapshot stream with polling fallback, the selected radio's control lease and every write operation for the whole workspace. `MediaProvider` owns one media controller for the selected radio. Selecting a radio never retunes it; changing radio, server or account, or signing out, stops all media and releases the lease.
- **Faceplate** (`RadioFaceplate`): status indicator, name, verification badge, monospace MHz.kHz frequency with smaller Hz digits, mode box and a confidence underline (solid confirmed, dotted inferred, "— — —" unknown), TX pill, offset, active memory and control-owner chip. `list` cards select; the `hero` variant is static.
- **Frequency dial** (`FrequencyDial`): one column per digit with up / down buttons, web wheel and keyboard (arrows, PageUp / PageDown, Enter applies, Escape reverts), an adjustable accessibility role, a "Type" fallback using `parseFrequencyInput`, and blocked out-of-range values. Integer Hz only.
- **Band bar** (`BandBar`): an SVG strip of the driver's tuning ranges with confirmed and draft markers; tapping only moves the draft.
- **Tuning panel**: dial, step / mode / offset segmented controls, band bar, a warning-tone pending row while desired and confirmed tuning differ, and an explicit Apply / Revert.
- **Memory grid**: tiles with name, frequency, mode, offset and band; the active memory is labelled "Active"; overwriting asks for confirmation.
- **PTT** (`PttButton`): hold-to-talk with an SVG ring for the remaining part of the 30-second limit and explicit states (ready, preparing, on air in red, stopping, unavailable with a reason). Pressing is never shown as confirmed transmission. Keyboard Space / Enter only while the button is focused.
- **Level meter** (`LevelMeter`): about 20 segments polled at ~15 Hz only while listening on a visible screen, 2 Hz under reduced motion, announced as "Receiving audio" / "Silent".
- **Station strip** (`StationStrip`): a persistent compact bar on every section except Radios with name, frequency and mode, status, TX pill, listen toggle, compact PTT (only when transmitting is allowed) and "Open radio". Navigating stops transmission but keeps listening.

### Review (Stage 2)

- **Activity heatmap** (`ActivityHeatmap`): 7 days × 24 hours of communication counts with a Less / More legend, roving keyboard focus and per-cell labels such as "Tuesday 21:00, 12 communications". Selecting a cell filters the timeline.
- **Waveform** (`Waveform`): bars from server-computed peaks (TX in the error tone), or a flat duration bar when the recording cannot be decoded.
- **Timeline**: direction icon, time, duration, frequency chip (dashed when attribution is not confirmed), waveform, inline transcript and an overflow menu; coverage gaps render as dashed "No coverage" rows in chronological position. Filters are chip groups; search is live with a 350 ms debounce.
- **Incident board** (`IncidentBoard`): New → Acknowledged → In progress → Closed columns side by side on wide layouts, a segmented column picker on compact ones. Priority uses icon plus text (▲▲ Critical, ▲ High, ● Medium, ○ Low). Transitions are explicit buttons; closing uses a sheet with reason chips. Rules use `ChipInput` phrases and `FrequencyRangePicker`.
- **Command palette** (`CommandPalette`): ⌘K / Ctrl K on web and a search button on every platform; one input with ↑ / ↓ / Enter / Escape. It tunes (only when the station is editable, otherwise it explains "Take control first"), recalls memories, selects radios, navigates, opens incidents and toggles control or listening, and reports results with toasts.

### Configuration (Stage 3)

- **Wizard**: a `Stepper` over steps that validate before Next, a review step with jump-back buttons, and confirmation before saving over an existing configuration. Used by the radio setup wizard (Driver → Identity & connection → Settings → Review & save → Access) and the processing provider wizard (Provider → Credentials → Options → Review). Selection cards use radio-group semantics with capability icons and badges; IDs are generated, never typed. On web the cards follow the radio-group keyboard pattern (`useRadioGroupKeyboard` in `apps/client/src/shared/radio-group.ts`: one Tab stop, Arrow keys move and select, Space selects). Each step change moves focus to the wizard title, whose accessible name includes "Step N of M: name"; Back stays mounted (disabled on the first step), and closing the radio wizard returns focus to the card or button that opened it. Password and provider-secret fields use `autoComplete="new-password"` so browsers never fill the saved station credential into them.
- **Setup checklist** (`SetupChecklist`): an administrator card on the Radios screen with numbered steps (check when done, dash when skipped), a segmented progress bar and one action per step. "Configure a radio" expands the configuration section and opens the wizard; "Open Users & access" and the wizard's Access step navigate to the permission matrix.
- **Permission matrix** (`PermissionMatrix`): users × radios, each cell a four-level radio group (None / Listen / Control / Transmit) whose icons fill cumulatively and whose caption names the level. Levels a role cannot hold are disabled with a reason. Changes are staged per user behind a dashed "N unsaved changes" bar. Wide containers render a table, narrow ones a card per user. Secondary permissions are checkbox chips in an expandable row.
- **Password strength** (`PasswordStrength`): a four-segment meter with a level label and hint, announced politely; advisory only (the backend enforces 12–1024 characters).
- **Quiet hours** (`QuietHoursPicker`): a 24-cell bar — tap the first quiet hour, then the last (wrapping past midnight) — with half-hour partial cells, ±30-minute steppers per end, a "22:00 → 07:00" summary, an Off toggle and single-tab-stop keyboard access on web. Time zones use a searchable picker; cooldown uses presets plus a `NumberField`.
- **Speech flow**: Edit → Generate → Preview → Transmit as a visible stepper; Transmit needs a played preview of the current text and a confirmation, and shows an "On air" bar with Stop.
- **Station cards and QR**: recent stations show live health with `StatusIndicator` and the last-used time. Administrators can show a dark-on-light QR code of the station address (always light tokens, so scanners read it in dark mode); native builds can scan one, which only fills the address field.

## Navigation and screen migration

The station retains one session-scoped workspace. Desktop navigation is a persistent sidebar. Compact navigation exposes Radios, History, Map and Alerts, with station/account tools in More. Android's hardware back closes More or returns to Radios. Tab changes do not require decorative transition animations.

Existing navigation remains an internal workspace rather than a new file-based route/authentication migration. The current application has no public destination routes or native navigation stack. Expo Router was evaluated; introducing it would add a separate routing/session lifecycle migration. Media cancellation remains awaited before station navigation or radio selection.

| View                          | Result                                                                                                                                                             |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Server connection             | Recent-station cards with live health and last use, normalised address entry with inline validation, admin Share station QR, native Scan QR, confirmed forget      |
| Sign-in / administrator setup | Shared form layout, native inputs, clear primary action, preserved validation and credential handling                                                              |
| Radios                        | Faceplate grid, hero faceplate, control ownership, frequency dial and band bar, memory grid; admin setup checklist and radio configuration cards with setup wizard |
| Live audio                    | Listen toggle, level meter and hold-to-talk PTT; desktop rail only when audio is configured; persistent station strip on other sections                            |
| History                       | Activity heatmap, virtualized timeline with waveforms and coverage gaps, chip filters, live search, existing provenance and deletion safeguards                    |
| Incidents                     | Board by state with explicit transitions, evidence clips, reason-chip close sheet, rule builder with phrase chips and frequency range picker                       |
| APRS / digital                | Shared filters and packet rows, responsive map container, theme-aware overlays without camera reset, optional recording decoder                                    |
| Notifications                 | Inbox grouped by day; preference draft with category cards, frequency chips, quiet-hours bar, time-zone picker and cooldown presets                                |
| Processing                    | Sections for speech & jobs, providers (wizard), profiles and automatic RX; speech stepper; user picker for the service owner; preview pauses when hidden           |
| Sessions                      | Shared session surfaces and explicit confirmation before revocation                                                                                                |
| Users / radio access          | Permission matrix with staged per-user saves, role segmented control, password strength; existing contracts and confirmations retained                             |

Switching destinations retains history searches and other visited forms. The control lease belongs to the workspace's `StationProvider`, so it survives section changes (the station strip keeps it visible); it is released on radio change, account or server change, sign-out and workspace unmount. Navigation stops transmission but not listening. Hidden recording players and speech previews pause; radio/audio context changes still stop transmission through the existing media supervisor. Changing user or server remounts the workspace, preserving isolation.

## Technology decisions

The design keeps Expo, React Native, authentication, APIs and media contracts at their existing versions and boundaries. New runtime dependencies are the SDK-compatible `@expo/ui`, `react-native-safe-area-context`, `react-native-svg`, `expo-camera` (native QR scanning only) and `qrcode` (only its pure encoder core is imported; drawing uses `react-native-svg`). Native generation is managed by Expo; generated iOS/Android folders are ignored. Native editing, switching, audio playback and the browser audio element remain platform controls.

Official references consulted during implementation:

- [Expo UI for SDK 58](https://docs.expo.dev/versions/v58.0.0/sdk/ui/)
- [Universal components](https://docs.expo.dev/versions/v58.0.0/sdk/ui/universal/)
- [Universal Switch and Host usage](https://docs.expo.dev/versions/v58.0.0/sdk/ui/universal/switch/)
- [Expo Router](https://docs.expo.dev/router/introduction/)

## Validation and remaining acceptance

See [validation](validation.md) for the actual checks and remaining platform gates. Compilation and synthetic station review do not constitute acceptance of physical transmission, native audio, external providers or production deployment.
