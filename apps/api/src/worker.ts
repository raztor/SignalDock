import { fileURLToPath } from 'node:url';
import { loadInstanceIdentity } from './modules/instance/identity-store.js';
import { createStation } from './app/station.js';
import { disposeMediaRuntime } from '@signaldock/media-gateway';

const connectionString = process.env['DATABASE_URL'];
if (!connectionString)
  throw new Error('DATABASE_URL is required for a worker.');
const dataDirectory =
  process.env['SIGNALDOCK_DATA_DIR'] ??
  fileURLToPath(new URL('../../../.local/instance', import.meta.url));
const station = await createStation({
  identity: await loadInstanceIdentity(dataDirectory),
  dataDirectory,
  connectionString,
  startRadios: false,
  startJobs: true,
  logger: true,
  ...(process.env['SIGNALDOCK_RELAY_URL']
    ? { relayUrl: process.env['SIGNALDOCK_RELAY_URL'] }
    : {}),
  ...(process.env['SIGNALDOCK_QUEUE_SCHEMA']
    ? { queueSchema: process.env['SIGNALDOCK_QUEUE_SCHEMA'] }
    : {}),
});
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.once(signal, () => {
    void station.server
      .close()
      .finally(() => disposeMediaRuntime())
      .catch(() => {
        process.exitCode = 1;
      });
  });
console.log(
  'SignalDock background worker started. Radio and HTTP admission are disabled in this process.',
);
