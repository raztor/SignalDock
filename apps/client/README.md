# Client frontend

Expo frontend for web, iOS, and Android. Current functionality is server discovery and recent-server management; native-device acceptance and live media remain separate gates.

```text
index.ts                       Expo registration
src/app/                       Application composition
src/features/<domain>/         Domain screens, data adapters, and state
src/shared/                    Cross-feature configuration and utilities
```

`src/features/servers` owns the implemented server selector. Feature folders documented as planned expose no placeholder routes or controls. Keep screens inside their feature and compose navigation/providers in `src/app`. Shared transport and DTOs come from `@signaldock/client-sdk` and `@signaldock/contracts`; vendor drivers are not frontend dependencies.

From the repository root: `npm run dev:client`, `npm run typecheck:client`, and `npm run export:web`. See [development setup](../../docs/development.md) and the [feature map](src/features/README.md).
