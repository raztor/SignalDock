# Processing connectors

Optional implementations use the versioned SDK. Core radio operation requires no processing credentials. `createProcessingRegistry()` installs these families; each connection declares its endpoint's actual supported subset.

- [openai-api](openai-api/README.md)
- [openai-compatible](openai-compatible/README.md)
- [openai-subscription-oauth](openai-subscription-oauth/README.md)
- [azure-speech](azure-speech/README.md)
- [ollama](ollama/README.md)

| Connector           | Structured text               | Recorded STT            | TTS               | Authentication                                 |
| ------------------- | ----------------------------- | ----------------------- | ----------------- | ---------------------------------------------- |
| OpenAI API          | Responses                     | Yes                     | WAV               | Instance API key                               |
| API-compatible      | Responses or Chat Completions | Configured subset       | Configured subset | API key or explicitly unauthenticated endpoint |
| OpenAI subscription | Eligible Responses models     | No                      | No                | User-owned supported subscription OAuth        |
| Azure Speech        | No                            | Fast transcription REST | RIFF PCM          | Instance resource key                          |
| Ollama              | JSON chat                     | No                      | No                | Local endpoint                                 |

There is no automatic provider fallback or advertised streaming speech. Endpoint redirects are refused. Local endpoints require `allowPrivateNetwork: true`. `CredentialVault` uses AES-256-GCM with instance/owner/credential binding. `ProcessingRuntime` checks authorization, source references and profile revisions before execution and final commit. Jobs enqueue transactionally; cancelled or superseded outputs are discarded.

Automatic RX transcription defaults off. Separate administrator consent binds the radio, exact endpoint, profile revision, provider configuration and service-owner user. Changes require renewed consent; user-owned subscription credentials cannot enable shared automation.

See [configuration, onboarding and acceptance](../../docs/implementation/processing.md). Mock/JWKS and loopback HTTP tests establish protocol conformance, not external account acceptance.
