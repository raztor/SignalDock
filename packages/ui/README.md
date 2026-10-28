# UI

Theme-aware presentation primitives for the Expo client. `tokens.ts` owns the visual foundations; `theme.tsx` binds them to system/light/dark preference; `primitives.tsx` supplies text, native fields, actions, layout and feedback. `screen-styles.ts` supplies common feature recipes. `SettingToggle` and `Checkbox` use Expo UI's universal native controls. `FeatureView` preserves destination state and lets media suspend while hidden.

Import from `@signaldock/ui`. Keep permission checks, radio control, provider operations and session ownership inside their existing feature modules. Use semantic tokens rather than screen-level color literals, and use `Button`/`Action` instead of creating another local action component.

Read the [design system](../../docs/frontend/design-system.md) for component conventions, migration scope, platform decisions and accessibility guidance, and the [validation record](../../docs/frontend/validation.md) for acceptance boundaries.
