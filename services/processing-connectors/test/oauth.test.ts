import { beforeAll, describe, expect, it, vi } from 'vitest';
import { exportJWK, generateKeyPair, SignJWT, type JWTPayload } from 'jose';
import type {
  ProcessingConnection,
  ProcessingProfile,
  ProcessingRequest,
} from '@signaldock/contracts';
import type { ProcessingExecutionContext } from '@signaldock/processing-sdk';
import {
  OpenAISubscriptionOAuth,
  type SubscriptionRegistration,
} from '../openai-subscription-oauth/src/oauth.js';
import { OpenAISubscriptionConnector } from '../openai-subscription-oauth/src/index.js';

const issuer = 'https://auth.openai.com';
const resource = 'https://api.openai.com/v1';
const scopes = [
  'openid',
  'profile',
  'email',
  'offline_access',
  'resource.invoke',
  'chatgpt.tokens.use.direct',
];
const clientId = 'issued-client';
const subject = 'verified-subject';
const now = Date.now();
const expiration = Math.floor(now / 1000) + 3600;
let keys: Awaited<ReturnType<typeof generateKeyPair>>;
let jwk: Awaited<ReturnType<typeof exportJWK>>;
beforeAll(async () => {
  keys = await generateKeyPair('RS256');
  jwk = await exportJWK(keys.publicKey);
  jwk.kid = 'fixture-key';
});
async function token(
  kind: 'id' | 'access',
  changes: Record<string, unknown> = {},
  key = keys.privateKey,
) {
  return new SignJWT({
    iss: issuer,
    aud: kind === 'id' ? clientId : resource,
    sub: subject,
    iat: Math.floor(now / 1000),
    exp: expiration,
    ...(kind === 'access'
      ? { client_id: clientId, scope: scopes.join(' ') }
      : { email: 'verified@example.invalid' }),
    ...changes,
  })
    .setProtectedHeader({ alg: 'RS256', kid: 'fixture-key' })
    .sign(key);
}
function fixture() {
  const hostId = `urn:uuid:${crypto.randomUUID()}`;
  const state = {
    nonce: '',
    idClaims: {} as JWTPayload,
    accessClaims: {} as JWTPayload,
    overrides: {} as Record<string, unknown>,
    omitScope: false,
    exchanges: [] as URLSearchParams[],
    calls: [] as string[],
    failExchange: false,
    failJwks: false,
  };
  const fetcher: typeof fetch = async (url, init) => {
    state.calls.push(String(url));
    expect(init?.redirect).toBe('error');
    expect(init?.credentials).toBe('omit');
    if (String(url) === `${issuer}/.well-known/openid-configuration`)
      return Response.json({ issuer, jwks_uri: `${issuer}/jwks` });
    if (String(url) === `${issuer}/jwks`)
      return state.failJwks
        ? new Response(null, { status: 503 })
        : Response.json({ keys: [jwk] });
    expect(String(url)).toBe(`${issuer}/api/accounts/oauth/token`);
    const form = new URLSearchParams(init?.body as URLSearchParams);
    state.exchanges.push(form);
    expect(form.get('client_id')).toBe(clientId);
    expect(form.get('resource')).toBe(resource);
    if (state.failExchange) return new Response(null, { status: 400 });
    return Response.json({
      token_type: 'Bearer',
      expires_in: 3600,
      access_token: await token('access', state.accessClaims),
      refresh_token: 'rotated-refresh',
      id_token: await token('id', { nonce: state.nonce, ...state.idClaims }),
      ...(state.omitScope ? {} : { scope: scopes.join(' ') }),
      ...state.overrides,
    });
  };
  const oauth = new OpenAISubscriptionOAuth(hostId, {
    fetch: fetcher,
    now: () => now,
  });
  const saved = async (
    changes: Partial<SubscriptionRegistration> = {},
  ): Promise<SubscriptionRegistration> => ({
    issuer,
    subject,
    clientId,
    hostId: `urn:uuid:${crypto.randomUUID()}`,
    email: 'untrusted-transfer@example.invalid',
    accessToken: await token('access'),
    refreshToken: 'transferred-refresh',
    idToken: await token('id'),
    scopes: [...scopes],
    expiresAt: expiration * 1000,
    ...changes,
  });
  return { hostId, state, oauth, saved };
}

describe('official subscription registration and validation', () => {
  it('verifies signed identity and resource grants before completing current sign-in', async () => {
    const f = fixture();
    const flow = f.oauth.begin('http://127.0.0.1:1455/auth/callback');
    f.state.nonce = flow.pending.nonce;
    expect(new URL(flow.url).searchParams.get('client_id')).toBe(
      'dynamic_agent_client',
    );
    const callback = `http://127.0.0.1:1455/auth/callback?state=${flow.pending.state}&code=single-code&client_id=${clientId}`;
    const registration = await f.oauth.complete(
      callback,
      flow.pending,
      new AbortController().signal,
    );
    expect(registration.subject).toBe(subject);
    expect(registration.clientId).toBe(clientId);
    expect(registration.expiresAt).toBe(expiration * 1000);
    expect(registration.scopes).toEqual(scopes);
    expect(f.state.exchanges[0]?.get('code_verifier')).toBe(
      flow.pending.verifier,
    );
    await expect(
      f.oauth.complete(callback, flow.pending, new AbortController().signal),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    const wrong = f.oauth.begin('http://127.0.0.1:1455/auth/callback');
    f.state.nonce = wrong.pending.nonce;
    f.state.idClaims = { aud: 'different-client' };
    await expect(
      f.oauth.complete(
        `http://127.0.0.1:1455/auth/callback?state=${wrong.pending.state}&code=code&client_id=${clientId}`,
        wrong.pending,
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });
  it('rejects remote callbacks and denied or mismatched state without any network exchange', async () => {
    const f = fixture();
    expect(() =>
      f.oauth.begin('https://server.example/auth/callback'),
    ).toThrow();
    expect(() =>
      f.oauth.begin('http://localhost:1455/auth/callback'),
    ).toThrow();
    const flow = f.oauth.begin('http://127.0.0.1:1455/auth/callback');
    await expect(
      f.oauth.complete(
        'http://127.0.0.1:1455/auth/callback?state=wrong&code=code',
        flow.pending,
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    await expect(
      f.oauth.complete(
        `http://127.0.0.1:1455/auth/callback?state=${flow.pending.state}&error=access_denied`,
        flow.pending,
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(f.state.calls).toHaveLength(0);
  });
  it('requires trusted token-response scopes during first sign-in', async () => {
    const f = fixture();
    const flow = f.oauth.begin('http://127.0.0.1:1455/auth/callback');
    f.state.nonce = flow.pending.nonce;
    f.state.omitScope = true;
    await expect(
      f.oauth.complete(
        `http://127.0.0.1:1455/auth/callback?state=${flow.pending.state}&code=code&client_id=${clientId}`,
        flow.pending,
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });
});

describe('protected imported subscription binding', () => {
  it('verifies the transferred grant and refreshes before activating, preserving the target host', async () => {
    const f = fixture();
    const saved = await f.saved();
    const registration = await f.oauth.importRegistration(
      saved,
      new AbortController().signal,
    );
    expect(registration.hostId).toBe(f.hostId);
    expect(registration.hostId).not.toBe(saved.hostId);
    expect(registration.email).toBe('verified@example.invalid');
    expect(registration.refreshToken).toBe('rotated-refresh');
    expect(registration.scopes).toEqual(scopes);
    expect(registration.expiresAt).toBe(expiration * 1000);
    expect(f.state.exchanges).toHaveLength(1);
    expect(f.state.exchanges[0]?.get('grant_type')).toBe('refresh_token');
    expect(f.state.exchanges[0]?.get('refresh_token')).toBe(
      'transferred-refresh',
    );
    expect(f.state.exchanges[0]?.get('scope')).toBeNull();
  });
  it('rejects an API key substituted for an imported access token before refreshing', async () => {
    const f = fixture();
    await expect(
      f.oauth.importRegistration(
        await f.saved({ accessToken: 'sk-proj-api-key-substitution' }),
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(f.state.exchanges).toHaveLength(0);
  });
  it.each([
    ['subject', { sub: 'another-person' }, 'UNAUTHORIZED'],
    ['client', { client_id: 'another-issued-client' }, 'UNAUTHORIZED'],
    ['audience', { aud: 'https://another.example/api' }, 'UNAUTHORIZED'],
    ['issuer', { iss: 'https://another.example' }, 'UNAUTHORIZED'],
    ['missing expiry', { exp: undefined }, 'UNAUTHORIZED'],
    ['expired token', { exp: Math.floor(now / 1000) - 20 }, 'UNAUTHORIZED'],
    ['missing inference scope', { scope: 'openid profile' }, 'FORBIDDEN'],
  ] as const)(
    'rejects an imported access token with a different %s',
    async (_label, claims, code) => {
      const f = fixture();
      await expect(
        f.oauth.importRegistration(
          await f.saved({ accessToken: await token('access', claims) }),
          new AbortController().signal,
        ),
      ).rejects.toMatchObject({ code });
      expect(f.state.exchanges).toHaveLength(0);
    },
  );
  it('rejects an ID/access identity mismatch', async () => {
    const f = fixture();
    await expect(
      f.oauth.importRegistration(
        await f.saved({
          idToken: await token('id', { sub: 'different-id-owner' }),
        }),
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(f.state.exchanges).toHaveLength(0);
  });
  it('rejects a forged access signature even with a valid ID token', async () => {
    const f = fixture();
    const other = await generateKeyPair('RS256');
    await expect(
      f.oauth.importRegistration(
        await f.saved({
          accessToken: await token('access', {}, other.privateKey),
        }),
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(f.state.exchanges).toHaveLength(0);
  });
  it.each(['scopes', 'expiry'] as const)(
    'rejects fabricated transferred %s',
    async (field) => {
      const f = fixture();
      const saved = await f.saved(
        field === 'scopes'
          ? { scopes: [...scopes, 'fabricated.admin'] }
          : { expiresAt: expiration * 1000 + 86400000 },
      );
      await expect(
        f.oauth.importRegistration(saved, new AbortController().signal),
      ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
      expect(f.state.exchanges).toHaveLength(0);
    },
  );
  it('rejects an unrelated refresh token even if the rotated response omits an ID token', async () => {
    const f = fixture();
    f.state.accessClaims = { sub: 'refresh-token-owner' };
    f.state.overrides = { id_token: undefined };
    await expect(
      f.oauth.importRegistration(
        await f.saved({ refreshToken: 'another-account-refresh' }),
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(f.state.exchanges).toHaveLength(1);
  });
  it('rejects a rotated ID token for another person', async () => {
    const f = fixture();
    f.state.idClaims = { sub: 'another-person' };
    await expect(
      f.oauth.importRegistration(await f.saved(), new AbortController().signal),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });
  it('fails closed on unavailable signing keys without reporting terminal credential revocation', async () => {
    const f = fixture();
    f.state.failJwks = true;
    await expect(
      f.oauth.importRegistration(await f.saved(), new AbortController().signal),
    ).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
    expect(f.state.exchanges).toHaveLength(0);
  });
  it('rejects failed refresh verification instead of accepting transferred access credentials', async () => {
    const f = fixture();
    f.state.failExchange = true;
    await expect(
      f.oauth.importRegistration(await f.saved(), new AbortController().signal),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(f.state.exchanges).toHaveLength(1);
  });
  it('rejects an API key returned as the replacement access token', async () => {
    const f = fixture();
    f.state.overrides = { access_token: 'sk-replacement-api-key' };
    await expect(
      f.oauth.importRegistration(await f.saved(), new AbortController().signal),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });
  it('derives refreshed expiry from signed claims and trusted response, never transfer metadata', async () => {
    const f = fixture();
    f.state.accessClaims = { exp: Math.floor(now / 1000) + 30 };
    const registration = await f.oauth.importRegistration(
      await f.saved(),
      new AbortController().signal,
    );
    expect(registration.expiresAt).toBe((Math.floor(now / 1000) + 30) * 1000);
  });
});

describe('resource-bound refresh and legacy dispatch', () => {
  it('uses the signed resource scope when a refresh response omits redundant scope metadata', async () => {
    const f = fixture();
    f.state.omitScope = true;
    f.state.overrides = { id_token: undefined };
    const registration = await f.oauth.refresh(
      await f.saved(),
      new AbortController().signal,
    );
    expect(registration.refreshToken).toBe('rotated-refresh');
    expect(registration.scopes).toEqual(scopes);
    expect(registration.hostId).toBe(f.hostId);
    expect(f.state.exchanges[0]?.get('scope')).toBeNull();
  });
  it('rejects response scopes that disagree with the signed access grant', async () => {
    const f = fixture();
    f.state.overrides = { scope: [...scopes, 'not-in-signed-grant'].join(' ') };
    await expect(
      f.oauth.refresh(await f.saved(), new AbortController().signal),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
  it('rejects a refreshed scope expansion without renewed authorization', async () => {
    const f = fixture();
    f.state.accessClaims = {
      scope: [...scopes, 'unexpected.new-scope'].join(' '),
    };
    f.state.overrides = {
      scope: [...scopes, 'unexpected.new-scope'].join(' '),
    };
    await expect(
      f.oauth.refresh(await f.saved(), new AbortController().signal),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
  it('never sends a legacy stored API key through subscription inference or model discovery', async () => {
    const fetcher = vi.fn<typeof fetch>();
    const userId = crypto.randomUUID();
    const instanceId = crypto.randomUUID();
    const connector = new OpenAISubscriptionConnector();
    const connection: ProcessingConnection = {
      connectionId: crypto.randomUUID(),
      instanceId,
      connectorId: 'openai-subscription-oauth',
      owner: { kind: 'user', userId },
    };
    const profile: ProcessingProfile = {
      profileId: crypto.randomUUID(),
      revision: 1,
      connectionId: connection.connectionId,
      capability: 'text.structured',
      allowCloud: true,
      model: 'fixture-model',
    };
    const request: ProcessingRequest = {
      instanceId,
      jobId: crypto.randomUUID(),
      profileId: profile.profileId,
      profileRevision: 1,
      task: 'conversation.summarize',
      taskVersion: 1,
      deadline: new Date(now + 60000).toISOString(),
      input: {
        kind: 'text',
        text: 'Private transcript',
        communicationIds: [crypto.randomUUID()],
      },
    };
    const context: ProcessingExecutionContext = {
      authentication: {
        kind: 'oauth',
        accessToken: 'sk-legacy-api-key',
        userId,
        accountId: subject,
        workspaceId: clientId,
      },
      endpoint: resource,
      capabilities: ['text.structured'],
      configuration: {},
      settings: {},
      fetch: fetcher,
      task: {
        instruction: 'Return a summary',
        normalizeOutput: () => ({
          kind: 'summary',
          text: 'unused',
          evidenceIds: [],
        }),
      },
    };
    await expect(
      connector.execute(
        request,
        connection,
        profile,
        new AbortController().signal,
        context,
      ),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    await expect(
      connector.listModels(context, new AbortController().signal),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(fetcher).not.toHaveBeenCalled();
  });
});
