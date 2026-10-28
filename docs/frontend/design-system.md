# Frontend design system

## Scope and audit

The client is a self-hosted radio workspace, built with Expo 58.0.19, React 19.3, React Native 0.88 and strict TypeScript. One application entry point composes independent feature modules. Authentication, server identity checks, control leases, media supervision, provider integration and radio permissions belong to their existing controllers and services.

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
- `Disclosure`: optional configuration, memories and provenance remain available without occupying the entire operational view. Its contents stay mounted so collapsing does not erase edits.
- `EmptyState`, `ErrorState`, `LoadingState`, `ConfirmDialog`, `ConfirmButton`: useful feedback and explicit confirmation for forgetting a station, revoking sessions or provider connections, and changing account access or passwords.
- `FeatureView`: preserves visited view state, exposes active/inactive context to playback, and contains a rendering failure to its destination with a retry action.

Use shared recipes for common presentation. Local styles express domain layout and use tokens; business logic does not belong in the presentation package. Do not add unused generic controls or new boolean-driven component families.

## Navigation and screen migration

The station retains one session-scoped workspace. Desktop navigation is a persistent sidebar. Compact navigation exposes Radios, History, Map and Alerts, with station/account tools in More. Android's hardware back closes More or returns to Radios. Tab changes do not require decorative transition animations.

Existing navigation remains an internal workspace rather than a new file-based route/authentication migration. The current application has no public destination routes or native navigation stack. Expo Router was evaluated; introducing it would add a separate routing/session lifecycle migration. Media cancellation remains awaited before station navigation or radio selection.

| View                          | Result                                                                                                                                                              |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Server connection             | Responsive introduction and concise connection form, actionable failure state, recent-station rows, confirmed forget action; development banner removed             |
| Sign-in / administrator setup | Shared form layout, native inputs, clear primary action, preserved validation and credential handling                                                               |
| Radios                        | Content-led station rows, prominent frequency, explicit selected/confirmed state, separate operation controls; channel memories and station configuration disclosed |
| Live audio                    | Single mobile scroll with radio content; desktop rail only when audio is configured; duplicate unavailable messages removed; hold/release semantics preserved       |
| History                       | Virtualized communication timeline, search and frequency filtering, optional station note form, existing transcript provenance and deletion safeguards              |
| Incidents                     | Shared type and status hierarchy, retained evidence/actions, optional rule configuration                                                                            |
| APRS / digital                | Shared filters and packet rows, responsive map container, theme-aware overlays without camera reset, optional recording decoder                                     |
| Notifications                 | Virtualized inbox first; delivery/preferences disclosed; accessible universal setting controls                                                                      |
| Processing                    | Speech/message jobs first; provider/profile/automatic-upload configuration disclosed; preview pauses when hidden                                                    |
| Sessions                      | Shared session surfaces and explicit confirmation before revocation                                                                                                 |
| Users / radio access          | Existing users remain prominent; new-user form disclosed; role and radio permissions retain existing contracts                                                      |

Switching destinations retains history searches and other visited forms. Radio operation still unmounts on exit to release its control lease. Hidden recording players and speech previews pause; radio/audio context changes still stop transmission through the existing media supervisor. Changing user or server remounts the workspace, preserving isolation.

## Technology decisions

The design keeps Expo, React Native, authentication, APIs and media contracts at their existing versions and boundaries. New runtime dependencies are the SDK-compatible `@expo/ui`, `react-native-safe-area-context` and `react-native-svg`. Native generation is managed by Expo; generated iOS/Android folders are ignored. Native editing, switching, audio playback and the browser audio element remain platform controls.

Official references consulted during implementation:

- [Expo UI for SDK 58](https://docs.expo.dev/versions/v58.0.0/sdk/ui/)
- [Universal components](https://docs.expo.dev/versions/v58.0.0/sdk/ui/universal/)
- [Universal Switch and Host usage](https://docs.expo.dev/versions/v58.0.0/sdk/ui/universal/switch/)
- [Expo Router](https://docs.expo.dev/router/introduction/)

## Validation and remaining acceptance

See [validation](validation.md) for the actual checks and remaining platform gates. Compilation and synthetic station review do not constitute acceptance of physical transmission, native audio, external providers or production deployment.
