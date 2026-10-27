# Open-source distribution and compatibility

## Distribution model

SignalDock source, protocols, schemas, deployment files, and extension SDKs are public project deliverables. Users can host their backend, serve the web client, build the mobile client, implement drivers/providers, or use the published mobile app with their server URL.

The publisher owns its mobile store accounts, signing credentials, app identifiers, and push project. None of those private credentials is distributed with source code. Third-party app builds use their own identifiers/credentials and can configure their own compatible relay.

The optional public relay is a convenience service, not a central account or mandatory dependency. Hosting policy, supported app projects, quotas, abuse handling, privacy, and operating costs must be published before opening it to arbitrary instances. Self-hosting a relay remains supported.

## Licensing and contributions

The canonical repository is [raztor/SignalDock](https://github.com/raztor/SignalDock). Preserve its existing [GNU Affero General Public License v3](../../LICENSE) without replacement. Include the license and a source-revision link in release artifacts and provide source access from the server's About page. Review distribution requirements for the intended mobile stores before the first app release.

Preserve benlink's license and notices. Review licenses and redistribution obligations of optional decoder/native packages; running a tool as another process does not by itself resolve every licensing question. Record dependency licenses and compatibility decisions in the release inventory.

Provide contribution guidelines, setup instructions, architecture overview, issue templates, security-reporting instructions, and conformance examples for both SDKs. Contributors should be able to run a simulated instance without a radio, cloud key, or publisher account.

Do not commit captured private audio, provider/session/push tokens, Bluetooth identifiers, app signing material, or operational databases. Public test fixtures use synthetic or explicitly licensed/authorized content.

## Version compatibility

Version application releases, public API protocol, driver API, relay protocol, and connector/task schemas separately. Published clients negotiate a supported protocol range and capability set. Additive optional capabilities do not force lockstep upgrades; incompatible changes require an explicit new major contract and migration plan.

An old client must show a useful incompatibility message rather than partially operating an unknown TX contract. Driver packages declare supported runtime/API versions and supported/verified device models.

## Release artifacts

Web assets/container, Linux multi-architecture backend/runtime images, mobile releases, deployment examples, generated API/SDK references, migration notes, and a verified hardware/OS matrix. Keep versions and source revisions traceable.

Publishing apps/images or enabling a public service is a separate action from writing these specifications. Store review, background-audio behavior, and notification behavior must pass release validation; their acceptance is not assumed.

## Acceptance

A new user can self-host without a central login, connect the published app by URL, and build a custom client with documented settings. A minimal example driver and processing connector pass their contract suites without modifications to core domain modules.
