import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { OpenAISubscriptionOAuth } from './oauth.js';

/** Local-only setup; transfer the protected output to the backend over SSH/HTTPS. */
export async function runSubscriptionSetup(options: { outputPath: string; hostPath: string; port?: number }): Promise<void> {
  await mkdir(dirname(options.hostPath), { recursive: true, mode: 0o700 });
  let hostId: string;
  try { hostId = (await readFile(options.hostPath, 'utf8')).trim(); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    hostId = `urn:uuid:${randomUUID()}`;
    await writeFile(options.hostPath, hostId + '\n', { flag: 'wx', mode: 0o600 });
  }
  const oauth = new OpenAISubscriptionOAuth(hostId);
  const abort = new AbortController();
  const server = createServer();
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(options.port ?? 1455, '127.0.0.1', resolve); });
  const address = server.address(); if (typeof address !== 'object' || !address) throw new Error('Could not open the loopback callback.');
  const redirectUri = `http://127.0.0.1:${address.port}/auth/callback`;
  const authorization = oauth.begin(redirectUri);
  console.log(`Open this URL on this computer to continue with ChatGPT:\n${authorization.url}`);
  const timer = setTimeout(() => { abort.abort(new Error('Subscription authorization timed out.')); server.close(); }, 5 * 60 * 1000);
  try {
    const registration = await new Promise<Awaited<ReturnType<typeof oauth.complete>>>((resolve, reject) => {
      abort.signal.addEventListener('abort', () => reject(abort.signal.reason), { once: true });
      server.on('request', (request, response) => {
        if (request.method !== 'GET' || !request.url?.startsWith('/auth/callback?')) { response.writeHead(404).end(); return; }
        void oauth.complete(new URL(request.url, redirectUri).href, authorization.pending, abort.signal).then((result) => {
          response.writeHead(200, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' }).end('Account linked. You may close this window.'); resolve(result);
        }).catch((error: unknown) => { response.writeHead(400, { 'Content-Type': 'text/plain' }).end('Authorization could not be verified.'); reject(error); });
      });
    });
    await mkdir(dirname(options.outputPath), { recursive: true, mode: 0o700 });
    await writeFile(options.outputPath, JSON.stringify(registration) + '\n', { mode: 0o600, flag: 'wx' });
    console.log(`Protected registration saved to ${options.outputPath}. Transfer it securely; never commit it.`);
  } finally { clearTimeout(timer); server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const outputIndex = process.argv.indexOf('--output');
  if (outputIndex < 0 || !process.argv[outputIndex + 1]) throw new Error('Use --output PATH for the new protected credential file.');
  await runSubscriptionSetup({ outputPath: resolve(process.argv[outputIndex + 1]!), hostPath: resolve('.local/openai-subscription-host-id') });
}
