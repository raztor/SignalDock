import { describe, expect, it } from 'vitest';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { OpenAISubscriptionOAuth } from '../openai-subscription-oauth/src/oauth.js';

describe('official subscription registration and validation', () => {
  it('verifies signature, audience, nonce and scopes before accepting a registration', async () => {
    const keys = await generateKeyPair('RS256'); const jwk = await exportJWK(keys.publicKey); jwk.kid = 'fixture-key';
    let nonce = ''; let expectedClient = 'issued-client';
    const fetcher: typeof fetch = async (url, init) => {
      if (String(url).endsWith('/.well-known/openid-configuration')) return Response.json({ issuer: 'https://auth.openai.com', jwks_uri: 'https://auth.openai.com/jwks' });
      if (String(url).endsWith('/jwks')) return Response.json({ keys: [jwk] });
      expect(String(url)).toBe('https://auth.openai.com/api/accounts/oauth/token');
      expect((init?.body as URLSearchParams).get('client_id')).toBe('issued-client');
      const idToken = await new SignJWT({ nonce, email: 'fixture@example.invalid' }).setProtectedHeader({ alg: 'RS256', kid: 'fixture-key' })
        .setIssuer('https://auth.openai.com').setAudience(expectedClient).setSubject('verified-subject').setIssuedAt().setExpirationTime('1h').sign(keys.privateKey);
      return Response.json({ token_type: 'Bearer', expires_in: 3600, access_token: 'protected-access', refresh_token: 'protected-refresh', id_token: idToken,
        scope: 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct' });
    };
    const oauth = new OpenAISubscriptionOAuth(`urn:uuid:${crypto.randomUUID()}`, { fetch: fetcher });
    const flow = oauth.begin('http://127.0.0.1:1455/auth/callback'); nonce = flow.pending.nonce;
    expect(new URL(flow.url).searchParams.get('client_id')).toBe('dynamic_agent_client');
    const callback = `http://127.0.0.1:1455/auth/callback?state=${flow.pending.state}&code=single-code&client_id=issued-client`;
    const registration = await oauth.complete(callback, flow.pending, new AbortController().signal);
    expect(registration.subject).toBe('verified-subject'); expect(registration.clientId).toBe('issued-client');
    await expect(oauth.complete(callback, flow.pending, new AbortController().signal)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    const wrongAudience = oauth.begin('http://127.0.0.1:1455/auth/callback'); nonce = wrongAudience.pending.nonce; expectedClient = 'different-client';
    await expect(oauth.complete(`http://127.0.0.1:1455/auth/callback?state=${wrongAudience.pending.state}&code=code&client_id=issued-client`, wrongAudience.pending, new AbortController().signal)).rejects.toThrow();
  });
  it('rejects remote callbacks and denied or mismatched authorization state', async () => {
    const oauth = new OpenAISubscriptionOAuth(`urn:uuid:${crypto.randomUUID()}`);
    expect(() => oauth.begin('https://server.example/auth/callback')).toThrow();
    expect(() => oauth.begin('http://localhost:1455/auth/callback')).toThrow();
    const flow = oauth.begin('http://127.0.0.1:1455/auth/callback');
    await expect(oauth.complete('http://127.0.0.1:1455/auth/callback?state=wrong&code=code', flow.pending, new AbortController().signal)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    await expect(oauth.complete(`http://127.0.0.1:1455/auth/callback?state=${flow.pending.state}&error=access_denied`, flow.pending, new AbortController().signal)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
  it('rotates refresh credentials without widening scopes and preserves the target host identity', async () => {
    const hostId = `urn:uuid:${crypto.randomUUID()}`; let body: URLSearchParams | undefined;
    const oauth = new OpenAISubscriptionOAuth(hostId, { verifyToken: async () => ({ sub: 'linked-owner' }), fetch: async (_url, init) => {
      body = init?.body as URLSearchParams;
      return Response.json({ token_type: 'Bearer', expires_in: 3600, access_token: 'new-access', refresh_token: 'rotated-refresh' });
    } });
    const saved = { issuer: 'https://auth.openai.com', subject: 'linked-owner', clientId: 'issued-client', hostId: `urn:uuid:${crypto.randomUUID()}`, accessToken: 'old-access', refreshToken: 'old-refresh', idToken: 'verified-token', scopes: ['resource.invoke', 'chatgpt.tokens.use.direct'], expiresAt: Date.now() + 60_000 };
    expect((await oauth.importRegistration(saved, new AbortController().signal)).hostId).toBe(hostId);
    const refreshed = await oauth.refresh(saved, new AbortController().signal);
    expect(body?.get('grant_type')).toBe('refresh_token'); expect(body?.get('scope')).toBeNull(); expect(body?.get('client_id')).toBe('issued-client');
    expect(refreshed.refreshToken).toBe('rotated-refresh'); expect(refreshed.hostId).toBe(hostId); expect(refreshed.scopes).toEqual(saved.scopes);
    await expect(oauth.importRegistration({ ...saved, scopes: ['openid'] }, new AbortController().signal)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});
