#!/usr/bin/env node
import { access, mkdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Test/development only. This isolated install survives workspace npm pruning.
const root = fileURLToPath(new URL('../../../', import.meta.url));
const runtime = join(root, '.local/pg-runtime');
const modulePath = join(
  runtime,
  'node_modules/embedded-postgres/dist/index.js',
);
await mkdir(runtime, { recursive: true });
try {
  await access(modulePath);
} catch {
  const installation = spawnSync(
    process.platform === 'win32' ? 'npm.cmd' : 'npm',
    [
      'install',
      '--prefix',
      runtime,
      '--no-audit',
      '--no-fund',
      'embedded-postgres@18.4.0-beta.17',
    ],
    { stdio: 'inherit' },
  );
  if (installation.status !== 0)
    throw new Error(
      'Could not install the isolated PostgreSQL development runtime.',
    );
}
const nativePackage = `@embedded-postgres/${process.platform}-${process.arch}`;
const nativeRoot = join(runtime, 'node_modules', nativePackage);
// npm may require explicit postinstall approval. The reviewed upstream script
// only restores native library symlinks shipped in pg-symlinks.json.
const hydration = join(nativeRoot, 'scripts/hydrate-symlinks.js');
try {
  await access(hydration);
  const result = spawnSync(process.execPath, [hydration], {
    cwd: nativeRoot,
    stdio: 'inherit',
  });
  if (result.status !== 0) throw new Error('Native library hydration failed.');
} catch (error) {
  if (error?.code !== 'ENOENT') throw error;
}
const { default: EmbeddedPostgres } = await import(
  pathToFileURL(modulePath).href
);
const port = Number(process.env.SIGNALDOCK_DEV_PG_PORT ?? 55432);
if (!Number.isInteger(port) || port < 1024 || port > 65535)
  throw new Error('Invalid development database port.');
const server = new EmbeddedPostgres({
  databaseDir: join(root, '.local/postgres18'),
  user: 'signaldock',
  password: 'local-test-only',
  port,
  persistent: true,
  postgresFlags: ['-h', '127.0.0.1'],
  onLog: (message) => {
    if (/FATAL|PANIC/.test(message)) process.stderr.write(message);
  },
  onError: (message) => process.stderr.write(String(message)),
});
let initialized = true;
try {
  await access(join(root, '.local/postgres18/PG_VERSION'));
} catch {
  initialized = false;
}
if (!initialized) await server.initialise();
await server.start();
const client = server.getPgClient();
await client.connect();
try {
  console.log((await client.query('SELECT version()')).rows[0].version);
  await client.query('DO $$ BEGIN PERFORM 1; END $$ LANGUAGE plpgsql');
  console.log(
    `TEST_DATABASE_URL=postgresql://signaldock:local-test-only@127.0.0.1:${port}/postgres`,
  );
} catch (error) {
  await server.stop();
  throw error;
} finally {
  await client.end();
}
let stopping = false;
for (const signal of ['SIGTERM', 'SIGINT'])
  process.once(signal, () => {
    if (stopping) return;
    stopping = true;
    void server.stop().then(() => process.exit());
  });
setInterval(() => {}, 30000);
