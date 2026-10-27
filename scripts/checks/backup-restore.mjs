import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Client } from 'pg';
import { createStation } from '../../apps/api/dist/app/station.js';
import { loadInstanceIdentity } from '../../apps/api/dist/modules/instance/identity-store.js';
import { CredentialVault } from '@signaldock/processing-connectors';
import { disposeMediaRuntime } from '@signaldock/media-gateway';

const base = process.env.TEST_DATABASE_URL;
if (!base)
  throw new Error(
    'Set TEST_DATABASE_URL to a disposable PostgreSQL installation with database-creation privileges.',
  );
const password = randomBytes(32).toString('base64url');
const suffix = randomUUID().replaceAll('-', '');
const names = [`sd_backup_${suffix}`, `sd_restore_${suffix}`];
const admin = new Client({ connectionString: base });
const temporary = await mkdtemp(join(tmpdir(), 'signaldock-restore-'));
let original, restored;
function databaseUrl(name) {
  const url = new URL(base);
  url.pathname = '/' + name;
  return url.href;
}
function postgresTool(name, connectionString, input) {
  const url = new URL(connectionString);
  const password = decodeURIComponent(url.password);
  url.password = '';
  const binary = process.env.SIGNALDOCK_PG_BIN_DIR
    ? join(process.env.SIGNALDOCK_PG_BIN_DIR, name)
    : 'docker';
  const toolArgs = [
    name === 'pg_dump' ? '--format=custom' : '--no-owner',
    ...(name === 'pg_restore' ? ['--no-privileges', '--exit-on-error'] : []),
    '--dbname',
    url.href,
  ];
  const args = process.env.SIGNALDOCK_PG_BIN_DIR
    ? toolArgs
    : [
        'run',
        '--rm',
        '-i',
        '--network=host',
        '--env',
        'PGPASSWORD',
        'postgres:18.6',
        name,
        ...toolArgs,
      ];
  const result = spawnSync(binary, args, {
    input,
    env: { ...process.env, PGPASSWORD: password },
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.status !== 0)
    throw new Error(
      `${name} failed: ${result.stderr?.toString() ?? result.error?.message ?? result.status}`,
    );
  return result.stdout;
}
try {
  await admin.connect();
  for (const name of names) await admin.query(`CREATE DATABASE ${name}`);
  const firstDirectory = join(temporary, 'original'),
    nextDirectory = join(temporary, 'restored');
  const identity = await loadInstanceIdentity(firstDirectory);
  original = await createStation({
    identity,
    dataDirectory: firstDirectory,
    connectionString: databaseUrl(names[0]),
    startJobs: false,
    startRadios: false,
    basePath: '/station',
  });
  await original.auth.bootstrap({
    setupToken: original.secrets.setupToken,
    username: 'backup-admin',
    password,
  });
  const firstLogin = await original.auth.login({
    username: 'backup-admin',
    password,
    sessionMode: 'token',
  });
  const communicationId = randomUUID(),
    radioId = randomUUID();
  const scope = {
    instanceId: identity.instanceId,
    credentialId: randomUUID(),
    ownerUserId: firstLogin.user.id,
  };
  const credential = { apiKey: 'disposable-restore-fixture' };
  const vault = new CredentialVault(
    original.secrets.activeKeyId,
    original.secrets.keys,
  );
  await original.database.query(
    'INSERT INTO sd_provider_credentials(instance_id,id,owner_user_id,envelope) VALUES($1,$2,$3,$4::jsonb)',
    [
      scope.instanceId,
      scope.credentialId,
      scope.ownerUserId,
      JSON.stringify(vault.seal(scope, credential)),
    ],
  );
  const keyring = await readFile(join(firstDirectory, 'station-secrets.json'));
  const bytes = Buffer.alloc(46);
  bytes.write('RIFF', 0);
  bytes.writeUInt32LE(38, 4);
  bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(8000, 24);
  bytes.writeUInt32LE(16000, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36);
  bytes.writeUInt32LE(2, 40);
  const communication = await original.history.ingest(
    {
      id: communicationId,
      instanceId: identity.instanceId,
      radioId,
      kind: 'received_voice',
      direction: 'rx',
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      frequencyHz: 147540000,
      frequencyAttribution: 'confirmed',
      context: { generation: randomUUID(), tuningRevision: 1 },
    },
    { bytes, contentType: 'audio/wav' },
  );
  await original.server.close();
  original = undefined;
  // Identity, provider keys and private artifacts are copied while station writers are stopped.
  await cp(firstDirectory, nextDirectory, {
    recursive: true,
    preserveTimestamps: true,
  });
  const dump = postgresTool('pg_dump', databaseUrl(names[0]));
  postgresTool('pg_restore', databaseUrl(names[1]), dump);
  const restoredIdentity = await loadInstanceIdentity(nextDirectory);
  assert.deepEqual(restoredIdentity, identity);
  restored = await createStation({
    identity: restoredIdentity,
    dataDirectory: nextDirectory,
    connectionString: databaseUrl(names[1]),
    startJobs: false,
    startRadios: false,
    basePath: '/station',
  });
  const secondLogin = await restored.auth.login({
    username: 'backup-admin',
    password,
    sessionMode: 'token',
  });
  assert.equal(secondLogin.user.id, firstLogin.user.id);
  assert.deepEqual(
    await readFile(join(nextDirectory, 'station-secrets.json')),
    keyring,
  );
  const encrypted = await restored.database.query(
    'SELECT envelope FROM sd_provider_credentials WHERE instance_id=$1 AND id=$2',
    [scope.instanceId, scope.credentialId],
  );
  assert.deepEqual(
    new CredentialVault(
      restored.secrets.activeKeyId,
      restored.secrets.keys,
    ).open(scope, encrypted.rows[0].envelope),
    credential,
  );
  const saved = await restored.history.get(
    identity.instanceId,
    communicationId,
  );
  assert.equal(saved.recording.sha256, communication.recording.sha256);
  assert.equal(saved.frequencyHz, 147540000);
  assert.deepEqual(
    (
      await restored.history.readRecording(
        identity.instanceId,
        saved.recording.id,
      )
    ).bytes,
    bytes,
  );
  assert.equal(restored.radios.runtime.list().length, 0);
  console.log(
    'Backup/restore passed: persistent identity, credentials, exact source context, recording bytes and no restored radio grants.',
  );
} finally {
  await original?.server.close().catch(() => undefined);
  await restored?.server.close().catch(() => undefined);
  for (const name of names)
    await admin
      .query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`)
      .catch(() => undefined);
  await admin.end();
  await rm(temporary, { recursive: true, force: true });
  await disposeMediaRuntime();
}
