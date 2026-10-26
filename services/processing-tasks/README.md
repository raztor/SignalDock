# Transcript task modules

This package supplies versioned tasks and deterministic local implementations. Task definitions describe their provider-neutral input, JSON output schema, prompt, normalization, and evidence validation. They do not select a provider or import radio control code.

| Task                     | Version                       | Local behavior                                                                                                        |
| ------------------------ | ----------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `callsign.extract`       | 1                             | Finds textual candidates and distinguishes self-identification candidates from third-party mentions.                  |
| `entities.extract`       | 1                             | Finds conservative place mentions. Providers may also return explicitly supported person and organization mentions.   |
| `emergency.classify`     | 1                             | Matches scoped literal distress phrases and returns evidence for human review.                                        |
| `conversation.summarize` | 1, supplied by the shared SDK | Returns the first three sentences, capped at 1,500 characters. This is an extractive preview, not a semantic summary. |

Install the three extension tasks with `registerAnalysisTasks(registry)`. Register `new LocalAnalysisConnector(rules)` for processing without cloud credentials. Generic connectors consume each task's `describePrompt` and `normalizeOutput`; adding a task does not require a provider-dispatch or radio change. Local algorithms remain explicit implementations of their supported tasks.

Embedded job runners and standalone workers share `createLocalTranscriptAnalysisHandler(service)` and `createRuleAnalysisHandler(service)`. These factories accept structural service ports, require a matching versioned job source, and forward the terminal commit context. They do not import application code.

Extraction and classification require one transcript communication per request. Every finding cites its communication ID, exact quote, and zero-based JavaScript UTF-16 start/end offsets. A normalizer rejects invented quotes, unrelated sources, and envelope references. Empty findings are valid. A callsign candidate never authenticates the speaker; a named place never establishes a geographic position.

Local incident rules support enabled state, priority, radio scope, confirmed-frequency bounds, and source-time bounds. Phrases are escaped literals, with a small English/Spanish negation heuristic. There are at most 100 rules, 30 phrases per rule, and 20 evidence matches per rule. Unknown frequencies do not satisfy frequency bounds. Detection does not provide complete emergency coverage; an unsupported or negative finding must not close an incident automatically.

The standalone connector defaults to `defaultEmergencyRules` when explicitly installed. The incident service has a separate, deliberately disabled default: it uses only configured rules unless the application explicitly enables `useDefaultRules`. Removing the last rule therefore disables detection in a normally configured instance.

Run `npx tsc -b services/processing-tasks` and `npx vitest run services/processing-tasks/test/tasks.test.ts`. Tests use no cloud calls or radio hardware.
