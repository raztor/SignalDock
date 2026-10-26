# Contributing

Start with [development setup](docs/development.md) and the [specification index](docs/specifications/README.md). The project uses its existing GNU AGPL v3 license. All maintained documentation, comments, CLI copy, and interface text use English.

Use the shared schemas and generated types instead of redefining contracts in consumers. Drivers and processing connectors remain separate extensions; manufacturer/provider details must not enter frontend domain logic. Tests should run with simulators and fixture connectors without a physical radio or external credentials.

Before submitting changes, run `npm run check`; regenerate affected contracts and bindings, run `npm run check:driver` when changing the driver protocol, and export the web client when changing it. Describe which acceptance gates were actually exercised and which remain unverified.

Never commit private recordings, operational reports/databases, identity keys, credentials, push tokens, or signing material. Physical transmission requires an explicitly prepared test; routine automated checks must not access a radio.
