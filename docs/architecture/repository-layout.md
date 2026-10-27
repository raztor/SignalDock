# Repository layout

SignalDock uses an application/workspace structure with domain modules inside each application. `apps/client` is the frontend; `apps/api` is the backend. Shared contracts and extension SDKs remain independent of both.

```text
SignalDock/
  apps/
    client/                         Expo web/iOS/Android frontend
      src/app/                      Application composition and navigation
      src/features/                 Servers, auth, radios, media, history,
                                    processing, incidents, APRS, notifications, admin
      src/shared/                   Cross-feature configuration/utilities
    api/                            TypeScript/Fastify backend
      src/app/                      Server composition and base-path config
      src/modules/                  Instance, health, identity, radios, media,
                                    history, processing, incidents, APRS,
                                    notifications, admin
      src/shared/http/              Common HTTP errors and response policy
      test/                         Backend integration tests
    worker/                         Reserved background application
    push-relay/                     Reserved optional delivery application
  packages/
    contracts/                      JSON schemas, types, OpenAPI artifacts
    client-sdk/                     Instance connection/client behavior
    radio-driver-sdk/               Generic radio API and TS/Python bindings
    processing-sdk/                 Connector/task contracts and registry
    ui/                             Reserved shared presentation package
  services/
    radio-runtime/
      src/runtime/                  Registry, leases, and operation dispatch
      src/simulation/               Simulated instance and demonstration
    drivers/
      vgc-benlink/
        src/                        Reserved production driver adapter
        validation/                 Existing Python hardware validation tools
        transports/macos/           Native Mac development transport
    processing-connectors/          Reserved OpenAI/API-compatible/OAuth,
                                    Azure Speech, and Ollama modules
  scripts/
    codegen/                        Contract/binding generation and its lock
    checks/                         Offline interoperability checks
    development/                    Reserved development helpers
    maintenance/                    Reserved deliberate maintenance commands
  deploy/                           Dockerfiles and Compose deployment
  docs/
    architecture/                   Repository/module boundaries
    specifications/                 Product specifications and acceptance plan
    development.md                  Setup, implemented status, and limitations
    hardware-validation.md          Physical-test evidence and procedures
```

## Module status

Implemented foundations are server selection/discovery, instance key persistence, process health, schemas/SDKs, simulators, fixture processing, and the initial discovery container. Each application's module index marks its actual status:

- [Frontend features](../../apps/client/src/features/README.md).
- [Backend modules](../../apps/api/src/modules/README.md).
- [Radio drivers](../../services/drivers/README.md), including [VGC / benlink attribution](../../services/drivers/vgc-benlink/README.md).
- [Processing connectors](../../services/processing-connectors/README.md).
- [Shared packages](../../packages/README.md).

Reserved folders contain a README defining responsibility and implementation stage. They do not contain fake implementations, register routes, enable advertised capabilities, or become npm packages merely by existing. Add a package manifest or executable entry point when the corresponding work package is implemented.

## Dependency rules

1. Application composition selects modules; domain code does not import another application's entry point.
2. Frontend features use the client SDK/contracts. They never import backend storage, provider SDKs, or radio transports.
3. Backend modules own authorization and domain workflows. Concrete radio/provider protocols stay behind their SDK boundaries.
4. Shared packages do not import applications. Add a shared abstraction when it has a concrete consumer rather than duplicating a DTO.
5. A radio driver owns its manufacturer-specific code, transport helpers, dependency locks, quirks, and validation tools.
6. Generic build/check/code-generation scripts live under `scripts`. Hardware procedures remain with their driver and run only explicitly.
7. Generated source and private runtime data remain separate. `results/`, `.local/`, virtual environments, installed dependencies, and build outputs remain ignored.

## Working in a module

Use `src` for executable code, `test` for relevant verification, and the module README for purpose, current status, configuration, commands, and integration boundaries. Feature subfolders such as `screens`, `data`, and future hooks/state are added where needed; backend routes/services/adapters stay inside their owning module.

Existing VGC reports and recordings remain in the repository-root `results/` directory. Relocation changes command paths, not the preserved evidence or the hardware procedures. See [development setup](../development.md) for the stable root npm commands and [hardware validation](../hardware-validation.md) for the relocated physical tools.
