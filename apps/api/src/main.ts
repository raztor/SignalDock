import { fileURLToPath } from 'node:url';
import { loadInstanceIdentity } from './identity.js';
import { buildServer } from './server.js';

const port = Number(process.env['PORT'] ?? 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error('PORT must be an integer from 1 to 65535.');
const identity = await loadInstanceIdentity(
  process.env['SIGNALDOCK_DATA_DIR'] ??
    fileURLToPath(new URL('../../../.local/instance', import.meta.url)),
);
const server = await buildServer({
  identity,
  displayName: process.env['SIGNALDOCK_DISPLAY_NAME'] ?? 'SignalDock station',
  basePath: process.env['SIGNALDOCK_BASE_PATH'] ?? '',
  allowedOrigins: (
    process.env['SIGNALDOCK_ALLOWED_ORIGINS'] ?? 'http://localhost:8081'
  )
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean),
  logger: true,
});
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void server.close().catch(() => {
      process.exitCode = 1;
    });
  });
}
await server.listen({ port, host: process.env['HOST'] ?? '127.0.0.1' });
