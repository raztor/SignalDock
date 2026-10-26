import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createRemoteJWKSet, customFetch, jwtVerify, type JWTPayload } from 'jose';
import { SignalDockError } from '@signaldock/contracts';
import { bodyBytes, object, stringValue } from '../../src/http.js';

const issuer = 'https://auth.openai.com';
const resource = 'https://api.openai.com/v1';
const requestedScopes = ['openid', 'profile', 'email', 'offline_access', 'resource.invoke', 'chatgpt.tokens.use.direct'];
export interface SubscriptionRegistration {
  issuer: string; subject: string; clientId: string; hostId: string; email?: string;
  accessToken: string; refreshToken: string; idToken: string; scopes: string[]; expiresAt: number;
}
export interface PendingSubscriptionAuthorization {
  state: string; nonce: string; verifier: string; redirectUri: string; createdAt: number;
  clientId?: string; expectedSubject?: string;
  consumed?: boolean;
}

export class OpenAISubscriptionOAuth {
  private readonly fetcher: typeof fetch;
  constructor(readonly hostId: string, private readonly options: {
    fetch?: typeof fetch;
    verifyToken?: (token: string, clientId: string, signal: AbortSignal) => Promise<JWTPayload>;
    now?: () => number;
  } = {}) {
    if (!/^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(hostId)) throw new SignalDockError('INVALID_ARGUMENT', 'Persist a valid opaque subscription host ID.');
    this.fetcher = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  }
  begin(redirectUri: string, saved?: SubscriptionRegistration): { url: string; pending: PendingSubscriptionAuthorization } {
    const redirect = new URL(redirectUri);
    if (redirect.protocol !== 'http:' || redirect.hostname !== '127.0.0.1' || redirect.pathname !== '/auth/callback' || !redirect.port || redirect.search || redirect.hash || redirect.username || redirect.password) {
      throw new SignalDockError('INVALID_ARGUMENT', 'Subscription authorization requires an HTTP 127.0.0.1 loopback callback at /auth/callback.');
    }
    const pending: PendingSubscriptionAuthorization = { state: randomBytes(32).toString('base64url'), nonce: randomBytes(32).toString('base64url'),
      verifier: randomBytes(48).toString('base64url'), redirectUri: redirect.href, createdAt: this.now(),
      ...(saved ? { clientId: saved.clientId, expectedSubject: saved.subject } : {}) };
    const url = new URL(`${issuer}/api/accounts/authorize`);
    const parameters: Record<string, string> = { client_id: saved?.clientId ?? 'dynamic_agent_client', ext_agent_host_id: this.hostId,
      response_type: 'code', redirect_uri: pending.redirectUri, scope: requestedScopes.join(' '), resource,
      state: pending.state, nonce: pending.nonce, code_challenge_method: 'S256', code_challenge: createHash('sha256').update(pending.verifier).digest('base64url') };
    if (!saved) parameters['agent_name_hint'] = 'SignalDock';
    for (const [key, value] of Object.entries(parameters)) url.searchParams.set(key, value);
    return { url: url.href, pending };
  }
  async complete(callback: string, pending: PendingSubscriptionAuthorization, signal: AbortSignal): Promise<SubscriptionRegistration> {
    const url = new URL(callback); const expected = new URL(pending.redirectUri);
    if (pending.consumed || url.origin !== expected.origin || url.pathname !== expected.pathname || this.now() - pending.createdAt > 5 * 60 * 1000 || !equal(url.searchParams.get('state') ?? '', pending.state)) {
      throw new SignalDockError('UNAUTHORIZED', 'The authorization state, callback, or deadline is invalid.');
    }
    pending.consumed = true;
    if (url.searchParams.has('error')) throw new SignalDockError('FORBIDDEN', 'Subscription authorization was denied.');
    const callbackId = url.searchParams.get('client_id');
    if (pending.clientId && callbackId && callbackId !== pending.clientId) throw new SignalDockError('UNAUTHORIZED', 'The returned registration does not match the selected account.');
    const clientId = pending.clientId ?? callbackId;
    const code = url.searchParams.get('code');
    if (!clientId || clientId === 'dynamic_agent_client' || !code) throw new SignalDockError('UNAUTHORIZED', 'Subscription registration did not return an issued client and code.');
    const tokens = await this.tokenRequest({ grant_type: 'authorization_code', client_id: clientId, code, code_verifier: pending.verifier, redirect_uri: pending.redirectUri, resource }, signal);
    const idToken = stringValue(tokens['id_token'], 'identity token', 64000);
    const claims = await this.verify(idToken, clientId, signal);
    if (!equal(String(claims.nonce ?? ''), pending.nonce) || !claims.sub || (pending.expectedSubject && claims.sub !== pending.expectedSubject)) throw new SignalDockError('UNAUTHORIZED', 'Subscription identity validation failed.');
    return this.registration(tokens, { clientId, hostId: this.hostId, issuer, subject: claims.sub,
      ...(typeof claims.email === 'string' ? { email: claims.email } : {}) });
  }
  async refresh(saved: SubscriptionRegistration, signal: AbortSignal): Promise<SubscriptionRegistration> {
    const tokens = await this.tokenRequest({ grant_type: 'refresh_token', client_id: saved.clientId, refresh_token: saved.refreshToken, resource }, signal);
    if (tokens['id_token'] !== undefined) {
      const claims = await this.verify(stringValue(tokens['id_token'], 'identity token', 64000), saved.clientId, signal);
      if (claims.sub !== saved.subject) throw new SignalDockError('UNAUTHORIZED', 'A refreshed token changed the linked identity.');
    }
    return this.registration(tokens, { ...saved, hostId: this.hostId });
  }
  async importRegistration(input: SubscriptionRegistration, signal: AbortSignal): Promise<SubscriptionRegistration> {
    if (input.issuer !== issuer || input.clientId === 'dynamic_agent_client' || !input.clientId || !input.accessToken || !input.refreshToken || !input.idToken || !Array.isArray(input.scopes)) {
      throw new SignalDockError('INVALID_ARGUMENT', 'The subscription credential transfer is invalid.');
    }
    const claims = await this.verify(input.idToken, input.clientId, signal);
    if (claims.sub !== input.subject || input.expiresAt <= this.now()) throw new SignalDockError('UNAUTHORIZED', 'The transferred credentials are expired or belong to another identity.');
    if (!input.scopes.includes('chatgpt.tokens.use.direct') || !input.scopes.includes('resource.invoke')) throw new SignalDockError('FORBIDDEN', 'The transferred registration has no inference grant.');
    return { ...input, hostId: this.hostId, scopes: [...input.scopes] };
  }
  async revoke(saved: SubscriptionRegistration, signal: AbortSignal): Promise<void> {
    const configuration = await this.discovery(signal);
    const revoke = safeAuthUrl(stringValue(configuration['revocation_endpoint'], 'revocation endpoint'));
    const response = await this.fetcher(revoke, { method: 'POST', redirect: 'error', credentials: 'omit', signal,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: saved.refreshToken, token_type_hint: 'refresh_token', client_id: saved.clientId }) });
    if (!response.ok) throw new SignalDockError('PROVIDER_UNAVAILABLE', 'Subscription revocation was not confirmed.');
  }
  private async verify(token: string, clientId: string, signal: AbortSignal): Promise<JWTPayload> {
    if (this.options.verifyToken) return this.options.verifyToken(token, clientId, signal);
    const configuration = await this.discovery(signal);
    const jwks = createRemoteJWKSet(safeAuthUrl(stringValue(configuration['jwks_uri'], 'JWKS endpoint')), {
      [customFetch]: (input, init) => this.fetcher(input, { ...init, redirect: 'error', credentials: 'omit', signal }),
    });
    const verified = await jwtVerify(token, jwks, { issuer, audience: clientId, algorithms: ['RS256', 'ES256'], clockTolerance: 5 });
    signal.throwIfAborted(); return verified.payload;
  }
  private async discovery(signal: AbortSignal): Promise<Record<string, unknown>> {
    const response = await this.fetcher(`${issuer}/.well-known/openid-configuration`, { redirect: 'error', credentials: 'omit', signal });
    if (!response.ok) throw new SignalDockError('PROVIDER_UNAVAILABLE', 'OpenID discovery failed.');
    const configuration = object(JSON.parse(new TextDecoder().decode(await bodyBytes(response, 65536))));
    if (configuration['issuer'] !== issuer) throw new SignalDockError('UNAUTHORIZED', 'OpenID discovery returned another issuer.');
    return configuration;
  }
  private async tokenRequest(values: Record<string, string>, signal: AbortSignal): Promise<Record<string, unknown>> {
    const response = await this.fetcher(`${issuer}/api/accounts/oauth/token`, { method: 'POST', redirect: 'error', credentials: 'omit', signal,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(values) });
    if (!response.ok) { await response.body?.cancel(); throw new SignalDockError(response.status === 400 || response.status === 401 ? 'UNAUTHORIZED' : 'PROVIDER_UNAVAILABLE', 'Subscription token renewal or exchange failed. Reauthorize after a terminal credential failure.'); }
    return object(JSON.parse(new TextDecoder().decode(await bodyBytes(response, 128000))));
  }
  private registration(tokens: Record<string, unknown>, identity: Pick<SubscriptionRegistration, 'issuer' | 'subject' | 'clientId' | 'hostId'> & Partial<SubscriptionRegistration>): SubscriptionRegistration {
    if (tokens['token_type'] !== 'Bearer' || typeof tokens['expires_in'] !== 'number' || !Number.isFinite(tokens['expires_in']) || tokens['expires_in'] <= 0 || tokens['expires_in'] > 86400 ||
        typeof tokens['access_token'] !== 'string' || !tokens['access_token'] || typeof tokens['refresh_token'] !== 'string' || !tokens['refresh_token']) throw new SignalDockError('UNAUTHORIZED', 'The token response is invalid.');
    const scope = typeof tokens['scope'] === 'string' ? tokens['scope'].split(/\s+/).filter(Boolean) : identity.scopes ?? [];
    if (!scope.includes('chatgpt.tokens.use.direct') || !scope.includes('resource.invoke')) throw new SignalDockError('FORBIDDEN', 'The linked account did not grant subscription inference permission.');
    return { ...identity, issuer, subject: identity.subject, clientId: identity.clientId, hostId: this.hostId,
      accessToken: stringValue(tokens['access_token'], 'access token', 64000), refreshToken: stringValue(tokens['refresh_token'], 'refresh token', 64000),
      idToken: typeof tokens['id_token'] === 'string' ? tokens['id_token'] : identity.idToken ?? '', scopes: scope, expiresAt: this.now() + tokens['expires_in'] * 1000 };
  }
  private now(): number { return this.options.now?.() ?? Date.now(); }
}
function safeAuthUrl(value: string): URL {
  const url = new URL(value);
  if (url.origin !== issuer || url.username || url.password || url.hash) throw new SignalDockError('UNAUTHORIZED', 'OpenID returned an untrusted credential destination.');
  return url;
}
function equal(a: string, b: string): boolean { const left = Buffer.from(a); const right = Buffer.from(b); return left.length === right.length && timingSafeEqual(left, right); }
