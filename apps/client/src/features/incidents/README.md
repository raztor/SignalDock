# Incidents and alerts

`IncidentsScreen` accepts shared `FeatureScreenProps` and renders permitted-radio incident lists, state filters, cursor pagination, evidence, assessment provenance and operator history. Operators can acknowledge, begin, resolve, dismiss, reopen, assign themselves, add decision notes and manage source retention holds. Administrators can configure scoped literal detection rules.

`IncidentClient` uses the supplied instance URL and bearer session through the shared SDK. It validates incident records and returned instance identity. Screen context changes abort in-flight requests and discard stale results, keeping previous-server records out of a newly selected instance. Controls reflect radio permissions; the API remains authoritative.

Callsign candidates do not authenticate speakers, spoken places do not establish positions, and interpretations do not grant radio control. Resolution and dismissal require a decision note. New incidents hold source evidence until an operator explicitly releases it.

The feature supports Expo web and React Native components without platform-specific imports. Typechecking has passed; integrated browser interaction and native development-build acceptance remain separate gates. Integration owns application navigation and mounting this screen.

Specification: [08-analysis-incidents.md](../../../../../docs/specifications/08-analysis-incidents.md).

Implementation and validation: [analysis.md](../../../../../docs/implementation/analysis.md).
