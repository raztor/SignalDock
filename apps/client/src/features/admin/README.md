# Administration

`UserAdminScreen({ session })` is the administrator-only Users & access screen. It consumes the shared `FeatureScreenProps` contract. Radio configuration and global navigation are composed separately by the application shell.

- **Permission matrix** (`PermissionMatrix.tsx`): rows are users, columns are configured radios (`radios/configurations`, including radios the administrator is not assigned to). Each cell sets one cumulative level — None, Listen (`radio.listen`), Control (+ `radio.control`), Transmit (+ `radio.transmit`). Changes are staged per user and saved with that user's "Save changes" bar through the existing `PATCH admin/users/:id { role, radioPermissions }`. Only the three operational permissions are edited by a cell; every other permission in a grant, and grants for radios not shown, are preserved. Wide layouts render a table; narrow layouts render one card per user.
- **Expandable row**: role (listener / operator / administrator; demoting an administrator asks for confirmation), secondary permissions per radio (checkbox chips), account enable/disable and session revocation (confirmed), and password reset with a strength meter (confirmed).
- **Roles**: templates come from `admin/role-permissions`. The backend rejects permissions outside a role's template, so a role change removes those (and says so); promotion adds nothing. New assignments start with the role's secondary defaults. Listeners can only listen.
- **Password strength** (`password-strength.ts`, `PasswordStrength.tsx`): advisory four-level meter used by user creation, password reset and first-administrator setup. The backend only enforces 12–1024 characters.
- **Setup checklist** (`SetupChecklist.tsx`): shown to administrators on the Radios screen until a radio is configured, a non-administrator has radio access (or skipped), and live audio has been heard once on this device (or skipped). "Configure a radio" opens the radio setup wizard on the same screen (`onConfigureRadio`), "Open Users & access" navigates here (`onAssignAccess`), and `refreshKey` re-checks progress after a radio is saved. Flags are stored locally per station and account; the card can be dismissed.

Pure logic lives in `permission-model.ts`, `password-strength.ts` and `setup-checklist-model.ts`, each with node unit tests.

Role, permission, account-status, and password changes revoke existing sessions. Self-edit operations invalidate the current client session immediately. Local state is cleared when the URL, instance or account changes (a token refresh keeps staged drafts), and late responses cannot fill a new context. Returning to the section reloads users and radios, so a radio saved in the setup wizard appears as a new column. Staged drafts are discarded (with a notice) only if that account changes on the server. The processing service-owner picker reads the same `GET admin/users` response and validates it with the same `PublicUserSchema`.

Backend authorization is authoritative; hiding a control does not enforce a role. The backend also protects the last enabled administrator. Password recovery is available only through the server's local interactive recovery command.

Specification: [03-identity-administration.md](../../../../../docs/specifications/03-identity-administration.md).
