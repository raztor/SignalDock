# Evidence, sources, and open validations

Reviewed October 26, 2026. Vendor capabilities and preview authentication contracts must be checked again when implemented; no price/model/version claim is frozen by this list.

## Local hardware evidence

See [hardware-validation.md](../hardware-validation.md) and the preserved local reports. Confirmed on the VR-N7500: reads, RX-frequency write/restoration, received voice playback on Mac, two-tone transmission, observed PTT on/off, listener confirmation, and original configuration restoration. This does not establish every related model, live network microphone, multi-radio hardware, or Linux production behavior.

## Primary sources

| Topic | Source | Design use |
|---|---|---|
| Radio library | [benlink](https://github.com/khusmann/benlink) | Initial driver/protocol implementation |
| VGC hardware | [VR-N7500](https://www.verotelecom.com/VERO-VR-N7500-50W-Dual-Band-Mobile-Radio-With-APP-Programming-p541441.html) | Device context, not a generic platform contract |
| Native Mac transport | [IOBluetoothDevice](https://developer.apple.com/documentation/iobluetooth/iobluetoothdevice) | Development-only hardware access |
| Universal frontend | [Expo web](https://docs.expo.dev/workflow/web/) | Shared web/native client |
| Native dependencies | [Expo development builds](https://docs.expo.dev/develop/development-builds/introduction/) and [React Native WebRTC](https://github.com/react-native-webrtc/react-native-webrtc) | Custom build and media feasibility gate |
| Session storage | [Expo SecureStore](https://docs.expo.dev/versions/latest/sdk/securestore/) | Mobile token storage |
| Mobile push | [Expo overview](https://docs.expo.dev/push-notifications/overview/) and [sending/receipts/security](https://docs.expo.dev/push-notifications/sending-notifications/) | Optional relay transport and delivery-state distinction |
| OpenAI API | [API authentication](https://developers.openai.com/api/reference/overview), [STT](https://developers.openai.com/api/docs/guides/speech-to-text), [TTS](https://developers.openai.com/api/docs/guides/text-to-speech) | API-key connector family |
| Subscription access | [OSS overview](https://developers.openai.com/siwc/token-sharing-open-source), [registration](https://developers.openai.com/siwc/token-sharing-open-source/sign-in), [inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference) | Separate OAuth connector |
| Subscription constraints | [Preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations), [self-hosted VMs](https://developers.openai.com/siwc/token-sharing-open-source/self-hosted-vms) | No assumed audio API support or invented remote callback |
| Local extensibility | [Ollama compatibility](https://docs.ollama.com/api/openai-compatibility) | Partial compatibility, capabilities must be explicit |
| Alternative speech | [Azure languages](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/language-support), [phrase lists](https://learn.microsoft.com/en-gb/azure/ai-services/speech-service/improve-accuracy-phrase-list), [data handling](https://learn.microsoft.com/en-us/azure/foundry/responsible-ai/speech-service/speech-to-text/data-privacy-security) | Optional connector and evaluation |
| Alternative STT | [Deepgram models/languages](https://developers.deepgram.com/docs/models-languages-overview) | Candidate to benchmark, no claimed quality ranking |
| Digital tools | [Dire Wolf](https://github.com/wb2osz/direwolf), [multimon-ng](https://github.com/EliasOenal/multimon-ng) | Decoder candidates requiring sample/license checks |
| Containers | [Docker runtime access](https://docs.docker.com/engine/containers/run/) | Scoped hardware permissions |
| Repository and license | [SignalDock](https://github.com/raztor/SignalDock), [existing LICENSE](https://github.com/raztor/SignalDock/blob/main/LICENSE) | Canonical repository and preserved GNU AGPL v3 license |

## Unverified release-critical points

Expo media/background behavior on real devices; selected Node media stack/ARM64; per-burst frequency attribution; generic driver conformance; real multi-radio contention; native APRS packet feed; STT quality/cost; OAuth headless onboarding and usage scope; public relay enrollment ownership proof; browser push; Linux Bluetooth/container permissions; and failure-mode RF termination.

Documentation describes these as requirements and gates, never as completed integrations. No provider keys, operational server credentials, or radio recordings were sent to external processing services while preparing this specification.
