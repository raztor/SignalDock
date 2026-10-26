# Services and integrations

- [radio-runtime](radio-runtime/README.md): radio registry, control ownership, and simulation.
- [drivers](drivers/README.md): manufacturer-specific hardware modules.
- [processing-connectors](processing-connectors/README.md): external/local processing integrations.

Concrete integrations implement shared SDK boundaries. Their vendor-specific transports, dependency locks, and validation tools remain inside the module that needs them.
