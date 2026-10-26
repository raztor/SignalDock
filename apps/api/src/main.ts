import { fileURLToPath } from 'node:url';
import { loadInstanceIdentity } from './modules/instance/identity-store.js';
import { buildServer } from './app/create-server.js';
import { createStation, loadDriverCredentials } from './app/station.js';

const port = Number(process.env['PORT'] ?? 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error('PORT must be an integer from 1 to 65535.');
const dataDirectory =
  process.env['SIGNALDOCK_DATA_DIR'] ??
  fileURLToPath(new URL('../../../.local/instance', import.meta.url));
const identity = await loadInstanceIdentity(dataDirectory);
const common = {
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
};
const connectionString = process.env['DATABASE_URL'];
const mediaUrl = process.env['LIVEKIT_URL'];
const cookieOrigin = process.env['SIGNALDOCK_COOKIE_ORIGIN'];
const station = connectionString
  ? await createStation({
      ...common,
      dataDirectory,
      connectionString,
      driverCredentials: await loadDriverCredentials(
        process.env['SIGNALDOCK_DRIVER_CREDENTIALS_FILE'],
      ),
      ...(cookieOrigin
        ? { cookieOrigin, secureCookies: !cookieOrigin.startsWith('http:') }
        : {}),
      ...(mediaUrl
        ? {
            livekit: {
              serverUrl: mediaUrl,
              apiKey: process.env['LIVEKIT_API_KEY'] ?? '',
              apiSecret: process.env['LIVEKIT_API_SECRET'] ?? '',
            },
          }
        : {}),
    })
  : undefined;
const server = station?.server ?? (await buildServer(common));
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void server.close().catch(() => {
      process.exitCode = 1;
    });
  });
}
await server.listen({ port, host: process.env['HOST'] ?? '127.0.0.1' });
