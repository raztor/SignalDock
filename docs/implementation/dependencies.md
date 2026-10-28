# Dependency compatibility

Reviewed on October 26, 2026 against the npm registry, PyPI, upstream release metadata, and the published container tags. Use the newest stable version supported by the consuming SDK and runtime. An upstream exact version requirement takes precedence over another package's `latest` tag. Keep exact direct versions and commit the npm lockfile after resolving updates.

## Compiler and client

| Component                       | Selected version | Compatibility decision                                                                                                                                                                           |
| ------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Node.js                         | 24.22.1          | Current Node 24 LTS release; shared by `.nvmrc` and application images.                                                                                                                          |
| Node types                      | 24.19.2          | Latest types for the Node 24 runtime; Node 26 types expose a different runtime API.                                                                                                              |
| TypeScript compiler             | 7.0.2            | Installed as `@typescript/native`, which provides the `tsc` executable used by existing build/typecheck scripts.                                                                                 |
| TypeScript compiler API         | 6.0.3            | `typescript` aliases `@typescript/typescript6` 6.0.2, which resolves the 6.0.3 API. Contract generation imports this API; Expo tooling can continue resolving `typescript`.                      |
| Expo                            | 58.0.19          | Latest stable SDK. Its installed module map and live version endpoint define the client compatibility baseline.                                                                                  |
| React / React DOM               | 19.3.0           | Exact pair recommended by Expo 58. Keep both aligned with the shared native client rather than independently moving web dependencies to 19.3.1.                                                  |
| React Native / React Native Web | 0.88.0 / 0.21.4  | Latest stable versions selected by the current Expo SDK.                                                                                                                                         |
| AsyncStorage                    | 2.2.0            | Restores Expo's recommended native version. The newer standalone 3.1.1 fails Expo's compatibility check. Existing saved-server storage uses the compatible `getItem`/`setItem`/`removeItem` API. |

TypeScript 7 does not expose the compiler API used by `scripts/codegen/api-catalog.mjs`. The package aliases follow Microsoft's [side-by-side migration guidance](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/#running-side-by-side-with-typescript-60). Do not replace the API alias with the native compiler package. `npm run check:generated` exercises the real contract generator and detects a broken API or changed output.

The remaining direct JavaScript dependencies already match their stable registry releases: Buf 2.16.0, Fastify 5.12.7, CORS 11.3.1, Argon2 2.2.2, gRPC JS 1.14.6, Zod 4.6.7, JOSE 6.2.13, pg/pg types 8.23.1, pg-boss 12.38.0, MapLibre 6.16.0, Vitest 5.0.5, Prettier 3.9.10, json-schema-to-typescript 16.0.0, React types 19.3.0, and the Expo 58 modules declared by the client. `npm update` refreshes transitive packages within their consumers' ranges, including electron-to-chromium 1.5.465; do not force unrelated transitive major upgrades.

References: [Expo AsyncStorage recommendation](https://docs.expo.dev/versions/latest/sdk/async-storage/), [Expo's versioned native module map](https://github.com/expo/expo/blob/sdk-58/packages/expo/bundledNativeModules.json), and [npm registry](https://registry.npmjs.org/).

## Media and Python

LiveKit RTC Node 1.2.1 requires **exactly** `@livekit/rtc-ffi-bindings` 0.13.1. The direct FFI import and RTC SDK must share that same native instance because permissions operate on SDK-owned handles. Retain 0.13.1 until an SDK release adopts 0.13.2 or a separately validated SDK migration is available. Installing a second 0.13.2 binding beside the SDK's 0.13.1 is not a compatible upgrade. Server SDK 2.19.2, browser SDK 2.23.0, and LiveKit server 1.13.11 remain current. See [RTC package requirements](https://registry.npmjs.org/@livekit%2frtc-node/1.2.1) and [media acceptance](media.md).

The Python requirements already select the latest stable grpcio/grpcio-tools 1.85.0, protobuf 7.36.2, bleak 3.0.2, pydantic 2.14.1, pydantic-core 2.50.1, and the macOS PyObjC 12.2.2 packages. Preserve the Mac validation lock independently of Linux installation. The benlink revision `c4b9d22112402ea193d376f412bc028d1778fdb4` matches upstream HEAD, but differs from the old `v0.1.1` release commit; retain the inspected hardware implementation.

CI and the driver image move to Python **3.13.18**, the newest patch in the supported 3.13 line. A move to Python 3.15 is a separate native-driver/runtime migration. The driver image pins `3.13.18-slim-bookworm` to make the patch and Debian family explicit. FFmpeg 9.0.2 is current on the validation Mac; container FFmpeg remains the distribution-supported apt package.

## Infrastructure and inherited exceptions

The web image uses `nginxinc/nginx-unprivileged:1.30.6-alpine`, the current [NGINX stable branch](https://nginx.org/en/download.html). The newer 1.31 line is mainline. Artifact upload moves to `actions/upload-artifact@v7.0.2`; checkout 7.0.1, setup-node/setup-python 7.1.0 and PostgreSQL 18.6 already match their stable releases. The Python and nginx tags publish both ARM64 and AMD64 images.

Two tooling dependencies cannot currently provide an entirely stable-only tree:

- Babel requires `gensync` 1.0.0-beta.2. Its old stable 0.1.0 cannot satisfy Babel's range.
- The isolated `embedded-postgres` development helper is already at its upstream latest, 18.4.0-beta.17; that project publishes no non-prerelease wrapper versions. This package is outside the product dependency tree. CI uses the official PostgreSQL 18.6 image.

Expo's image tooling also pins jimp-compact 0.16.1 exactly. Its `latest` tag is the prerelease-form 0.16.1-2, while the highest non-prerelease is 0.16.2. Preserve the SDK requirement instead of treating `latest` as automatically stable or adding an unverified override.

`npm audit` currently reports five high-severity package findings inherited through Expo's CLI, caused by [node-forge](https://github.com/advisories/GHSA-86w9-cpqp-85rv) and [Zod 3](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5). The product directly uses Zod 4.6.7. The audit's proposed Expo 54 downgrade would break the selected SDK matrix; replacing CLI Zod 3 with Zod 4 is also an unvalidated API change. Track these upstream findings separately from version freshness; this update does not claim a clean security audit.

## Validation

Run `npm ci` under Node 24, then `npm run check:dependencies`. This verifies the complete installed dependency graph and Expo's live compatibility recommendations; CI runs the same gate after installation.

Run `npm run check`, web export, Python driver tests, generated driver binding checks, simulation, backup/restore, and the LiveKit transport proof with a disposable database and synthetic hardware. Tests need both database URL variables and an explicit VGC Python environment to avoid silently skipping integration coverage. See [development](../development.md) for commands. Native device builds, physical radio tests and deployed image inspection remain separate acceptance gates.

The local update validation passed all 411 TypeScript tests across 55 files, all 32 operations tests, and all 38 Python driver tests, with no skipped tests. It also passed the TypeScript 7 build and client/test typechecks, live Expo dependency check, contract and driver regeneration checks, TS/Python wire round trip, simulation, web export, formatting, and license inventory (751 locked entries, no missing license metadata). This Mac run used Python 3.13.15 in an isolated test environment and the portable PostgreSQL 18.4 helper on a private loopback port. CI validates the Python 3.13.18/PostgreSQL 18.6 combination, backup restoration, container acceptance, and Linux ARM64 LiveKit transport. It also builds the updated Python driver image and runs its CLI help as an unprivileged user with a read-only filesystem, without Bluetooth or radio access.
