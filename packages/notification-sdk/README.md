# Notification SDK

The default export contains browser-safe private-relay schemas, deterministic signing-message bytes, installation enrollment orchestration, and safe saved-instance navigation. It imports no Node cryptography. `./server` provides Ed25519 signing/verification, the encrypted-token vault, and a signed backend relay client.

`InstallationEnrollmentClient` receives a platform `InstallationSigner`. A native implementation must generate and preserve its installation key using platform-protected storage and obtain a push token for its signed Expo development build. The client signs a received challenge only after a matching local enrollment request. Native/public enrollment remains gated; this SDK is not proof of physical push delivery.

`resolveNotificationReference` validates opaque references and selects only a known saved instance. It rejects additional payload properties, including URLs. Fetch referenced content through that saved instance's current authenticated session. Instance bearer tokens must never accompany relay requests.

The private protocol uses versioned domain-separated signatures. Wire schemas live here so browser and server implementations cannot disagree about their signed representation. Preserve existing protocol domains when adding fields; incompatible changes require a new protocol version.
