# Application composition

`App.tsx` composes instance selection, isolated authentication, role-aware navigation and domain screens. The authenticated workspace is keyed by canonical URL, pinned instance and user. Media stops before server, account, radio or route changes. Foreground notifications remain mounted within that workspace; credentials and audio never migrate across instances.

`transmit-speech.ts` obtains and renews a normal radio lease before an explicit prepared-speech action. The backend revalidates its source and uses the same supervised transmission path as microphone audio. Native media remains disabled until its development-build/device gate passes.
