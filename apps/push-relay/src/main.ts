import { PostgresDatabase, migrate } from '@signaldock/database';
import { hashSecret, TokenVault } from '@signaldock/notification-sdk/server';
import { ExpoPushTransport } from './expo.js';
import { RelayService } from './service.js';
import { buildRelayServer } from './server.js';
import { PostgresRelayStore, relaySchemaSql } from './store.js';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for the private relay.`);
  return value;
}
const database = new PostgresDatabase({
  connectionString: required('RELAY_DATABASE_URL'),
  max: 5,
});
try {
  const occupied = await database.query<{ occupied: string | null }>(
    "SELECT to_regclass('public.sd_users')::text AS occupied",
  );
  if (occupied.rows[0]?.occupied)
    throw new Error(
      'Configure a separate relay database rather than an instance database.',
    );
  const store = new PostgresRelayStore(database);
  const encryptionKey = Buffer.from(
    required('RELAY_TOKEN_KEY_BASE64'),
    'base64',
  );
  const transport = new ExpoPushTransport(required('EXPO_ACCESS_TOKEN'));
  const service = new RelayService(
    store,
    new TokenVault(encryptionKey),
    transport,
    {
      mode: 'private-test',
      projectId: required('RELAY_PROJECT_ID'),
      enrollmentSecretHash: hashSecret(required('RELAY_ENROLLMENT_SECRET')),
    },
  );
  await migrate(database, [{ id: '001_private_relay', sql: relaySchemaSql }]);
  const port = Number(process.env['PORT'] ?? 3001);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error('PORT must be an integer from 1 to 65535.');
  const app = buildRelayServer(service);
  const receipts = setInterval(() => {
    void service.pollReceipts().catch(() => undefined);
  }, 30000);
  const retention = setInterval(() => {
    void store
      .cleanup(
        new Date().toISOString(),
        new Date(Date.now() - 7 * 86400000).toISOString(),
      )
      .catch(() => undefined);
  }, 3600000);
  for (const signal of ['SIGINT', 'SIGTERM'] as const)
    process.once(signal, () => {
      clearInterval(receipts);
      clearInterval(retention);
      void app.close().finally(() => database.close());
    });
  try {
    await app.listen({ port, host: process.env['HOST'] ?? '127.0.0.1' });
  } catch (error) {
    clearInterval(receipts);
    clearInterval(retention);
    await app.close();
    throw error;
  }
} catch {
  await database.close();
  console.error(
    'Private relay startup failed. Check its isolated database and required configuration.',
  );
  process.exitCode = 1;
}
