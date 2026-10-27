# Web and mobile client

The Expo client provides configurable server selection, isolated sign-in sessions, administration, a multi-radio dashboard, control/memory selection, browser listening and microphone PTT, and private frequency history with playback.

Run `npm run dev:client` from the repository root after building the shared packages. The client stores recent server metadata separately from authenticated session state. Use the complete backend URL, including any deployment prefix. HTTPS is required outside loopback development.

Browser media requires a capable radio, explicit permissions, a live control lease for TX, and configured backend media. Simulator audio is unavailable. Context changes cancel pending media and stop active transmission. Native media remains gated on development-build/device acceptance.

Application registration and navigation are in `src/app`; independently owned features are in `src/features`. See [development](../../docs/development.md) and [physical browser acceptance](../../docs/implementation/vgc-acceptance.md). Processing, incidents, APRS and notification screens are composed through explicit capabilities. Native audio, maps and push still require device acceptance.
