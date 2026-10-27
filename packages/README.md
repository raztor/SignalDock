# Shared packages

- [contracts](contracts/README.md): public/domain schemas and generated interchange artifacts.
- [client-sdk](client-sdk/README.md): reusable client-side backend connection behavior.
- [radio-driver-sdk](radio-driver-sdk/README.md): radio extension contracts, simulator, and private wire bindings.
- [processing-sdk](processing-sdk/README.md): connector/task registry and fixture processing.
- [ui](ui/README.md): planned shared presentation primitives.

Keep application composition in `apps` and concrete hardware/provider integrations in `services`. A shared package must not import an application.
