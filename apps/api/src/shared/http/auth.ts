import {
  SignalDockError,
  type AuthenticationPort,
  type Permission,
  type Principal,
} from '@signaldock/contracts';

export async function requirePrincipal(
  request: { headers: { authorization?: string | undefined } },
  auth: AuthenticationPort,
  permission?: Permission,
  radioId?: string,
): Promise<Principal> {
  const authorization = request.headers.authorization;
  if (!authorization?.startsWith('Bearer ') || authorization.length <= 7) {
    throw new SignalDockError('UNAUTHORIZED', 'An access token is required.');
  }
  const principal = await auth.authenticate(authorization.slice(7));
  if (permission) await auth.authorize(principal, permission, radioId);
  return principal;
}
export const authorizeRequest = requirePrincipal;
