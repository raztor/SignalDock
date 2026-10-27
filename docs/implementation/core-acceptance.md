# Operational core acceptance

The operational core composes database-backed identity, radio-scoped permissions, independent radio runtimes, private VGC gRPC, self-hosted live media, browser RX/PTT, and private recordings with frequency context. Optional processing and push credentials are not required.

The standalone core revision passed 201 TypeScript tests across 30 files with PostgreSQL and real TS/Python interoperability enabled. Builds, client/test type checks, formatting, and generated artifacts also passed. The physical Mac browser acceptance is recorded separately in [VGC acceptance](vgc-acceptance.md): clear RX, AirPods microphone TX after initial choppiness, observed carrier termination, and independently verified restoration.

Radio startup is asynchronous and bounded. Pending configuration closes safely; transmission status includes unconfirmed carrier state. Fresh observations reconcile uncertain stops within the current generation. Server shutdown attempts every cleanup stage before reporting failures. Client media controls require server availability, radio capabilities, permissions, and connection state.

These results do not establish native mobile operation, physical Linux/Raspberry Pi support, abrupt OS/driver RF failure recovery, or fully smooth TX startup. Container, backup recovery, and ARM64 media checks belong to the deployment acceptance layer. Do not enable unattended production transmission based on fixture tests.
