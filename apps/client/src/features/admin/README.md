# Administration

`UserAdminScreen({ session })` implements administrator-only user creation, role changes, account activation, password reset, session revocation, and explicit radio assignment. It consumes the shared `FeatureScreenProps` contract. Radio configuration and global navigation are composed separately by the application shell.

The screen reads configured radio IDs from `radios/configurations`, including radios that the administrator has not yet assigned to their own account. Role templates come from the identity API, so operational permissions are assigned explicitly even for administrators. The template for an operator or administrator includes transmit permission on selected radios; the screen states this before saving.

Role, permission, account-status, and password changes revoke existing sessions. Self-edit operations invalidate the current client session immediately. Local form/data state is cleared when the URL, instance, account, or access token changes, and late responses cannot fill a new context.

Backend authorization is authoritative; hiding a control does not enforce a role. The backend also protects the last enabled administrator. Password recovery is available only through the server's local interactive recovery command.

Specification: [03-identity-administration.md](../../../../../docs/specifications/03-identity-administration.md).
