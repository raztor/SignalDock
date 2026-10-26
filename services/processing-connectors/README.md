# Processing connectors

Reserved provider modules are listed below. Their folders document boundaries only: no live provider, authentication flow, or model invocation has been implemented. The processing SDK already provides the registry and deterministic fixtures.

- [openai-api](openai-api/README.md)
- [openai-compatible](openai-compatible/README.md)
- [openai-subscription-oauth](openai-subscription-oauth/README.md)
- [azure-speech](azure-speech/README.md)
- [ollama](ollama/README.md)

Each future connector declares its actual capabilities, connection schema, authentication strategy, owner/usage policy, and conformance coverage. No vendor is required for core startup.
