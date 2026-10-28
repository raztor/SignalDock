# Frontend validation — 2026-10-28

## Software checks

Validation used Node 24, matching the repository's engine requirement. The final client type check, formatting check and production exports were repeated from an isolated local copy with the same lockfile because synced dependency files intermittently blocked reads. All 52 client and shared UI source files were compared byte-for-byte with the workspace before that final export.

| Check                                                          | Observed result                                                            |
| -------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `npm run build`                                                | Passed for the complete monorepo                                           |
| `npm run typecheck:client`                                     | Passed                                                                     |
| Client TypeScript with `--noUnusedLocals --noUnusedParameters` | Passed                                                                     |
| `npm run typecheck:tests`                                      | Passed                                                                     |
| Unit/integration fixtures available in this environment        | **299 passed; 112 skipped**, across 38 passing and 17 skipped files        |
| `npm run test:ops`                                             | **32 passed**                                                              |
| `npm run format:check`                                         | Passed across the repository's configured paths                            |
| `npm run check:generated`                                      | Passed; contract artifacts remain current                                  |
| Expo production export, web/iOS/Android                        | All three bundles generated successfully                                   |
| Semantic text/status contrast                                  | Light minimum 5.01:1; dark minimum 4.85:1; primary actions 7.13:1 / 9.27:1 |
| `git diff --check` on the changed scope                        | Passed                                                                     |

The repository has no dedicated lint command; strict TypeScript and the configured Prettier check are its available static checks.

The gRPC fixture needs a working Python environment. The existing `.venv-codegen` contained iCloud placeholders that timed out during import, so the successful full suite used `SIGNALDOCK_CODEGEN_PYTHON` pointing to a temporary local environment with the same installed `grpcio` 1.85.0 and `protobuf` 7.36.2 versions. The isolated gRPC suite passed all nine tests there. The default environment still times out; that environment issue has not been represented as a passing default command. The skipped suites require database/integration configuration that was not supplied during this review.

`expo install --check` reports an existing SDK patch alignment warning: the repository has Expo 58.0.19 and the checker recommends ~58.0.21. The redesign retains the existing SDK patch rather than changing the native runtime during the presentation migration. New dependencies fit the SDK 58 version family. A separate SDK patch update and native regression pass remain appropriate before release.

## Web visual and interaction review

The application was reviewed in a browser at 320×740, 390×844, 768×1024 and 1280×720. Both light and dark themes were inspected, including the exported production bundle. Width checks at 320 and 768 reported matching viewport and document widths, with no page-level horizontal overflow in the inspected views.

Reviewed destinations: server selection, sign-in, initial administrator setup, radio selection/operation, unavailable audio, history, incidents, APRS, notifications and preferences, processing, sessions and user administration.

Interaction checks included:

- Unreachable server feedback and successful retry.
- Saved-server selection and the confirmation/cancel/forget flow.
- Token-mode and same-origin session presentation using a local review fixture, without changing the client authentication controller.
- Confirmations for session revocation and account disabling; radio assignment uses the universal checkbox, and the shared web adapter exposes checked/selected/expanded states through ARIA.
- Moving between primary destinations and More, including selecting the already-active destination.
- Retaining an unsubmitted history search through navigation.
- Theme switching, device-stored preference and shared focus feedback.
- Expanding preferences, provider configuration, channel memories and other optional tools.
- Correcting the compact audio layout so it does not compete with radio controls for a fixed portion of the screen.
- Correcting the APRS header overflow and replacing an empty, unconfigured map area with an actionable empty state.

The review station is a local fixture with no hardware or external provider access; mutating operational endpoints are blocked. Its files and static preview server are under the ignored `.local` directory. The shipped client continues to use the existing session controller, SDK and API contracts.

Evidence is saved locally in `.local/frontend-review/`, including `desktop-production-light.jpg`, `mobile-production-dark.jpg`, and the native startup captures. The production export is in `.local/frontend-review/export-final/`.

## Native review

An isolated iPhone 17 Pro simulator running iOS 27 was created for the review. The iOS development binary **compiled, signed and installed successfully: zero errors and one SDK warning**. Launch against the local Metro server reached the redesigned server-connection screen. Its light and dark presentation was captured and inspected, including its safe-area layout.

The existing Expo modules provider reports an internal `CoreModule` visibility warning during native configuration. The development client also displays its warning affordance. These were retained as observed SDK/development warnings, not hidden to produce screenshots.

The native build initially failed when disk space ran out, then failed because iCloud attached Finder metadata to a generated ExpoModulesJSI framework. The framework was built outside the synced folder using the SDK's `EXPO_CUSTOM_BUILD_ROOT`, with the generated framework made available to CocoaPods. No SDK source changes were made. Native builds from a synced Documents directory require care with disk space and signing metadata; a local, unsynced checkout avoids those environmental constraints.

Native automation could not bind the Simulator application for interactive navigation. Therefore authenticated native flows, keyboard interactions and native setting toggles have **not** received a complete interactive acceptance pass. The initial screen's successful render is deliberately distinguished from that remaining work.

## Remaining release gates

- Complete authenticated iOS interaction, keyboard, dynamic text and assistive-technology review on a supported native automation setup or device.
- Run the Android application on an emulator/device. No Android target was connected; only its production bundle was validated.
- Execute the database-backed suites with the repository's disposable-database configuration.
- Resolve the existing Expo patch alignment warning and repeat native regression checks before release.
- Retain the existing acceptance gates for physical radio RX/PTT, native audio, interruptions, maps, push enrollment and live external providers. This redesign does not establish those physical/service integrations as newly accepted.

The frontend migration and the software checks above are implemented and reviewable. Complete production/platform acceptance remains open until these gates are satisfied.
