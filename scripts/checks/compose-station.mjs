import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';

if (process.env.CI !== 'true')
  throw new Error('Compose acceptance runs only in a disposable CI runner.');
const temporary = await mkdtemp(join(tmpdir(), 'sd-compose-'));
const project = 'sd-ci-' + randomBytes(6).toString('hex');
const env = { ...process.env, COMPOSE_PROJECT_NAME: project };
const override = join(temporary, 'images.yaml');
const privateEnv = 'deploy/.env';
const original = await readFile(privateEnv, 'utf8');
const originalUrl = original
  .split('\n')
  .find((line) => line.startsWith('DATABASE_URL='))
  ?.slice('DATABASE_URL='.length);
assert(originalUrl, 'Generate a private deployment environment first.');
const compose = [
  'compose',
  '--env-file',
  privateEnv,
  '-f',
  'deploy/compose.yaml',
  '-f',
  override,
  '--project-name',
  project,
];
let failed = true;
function docker(args, input) {
  try {
    return execFileSync('docker', args, {
      env,
      input,
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch {
    throw new Error('A disposable Compose acceptance step failed.');
  }
}
function sql(database, query) {
  return docker([
    ...compose,
    'exec',
    '-T',
    'db',
    'psql',
    '-U',
    'signaldock',
    '-d',
    database,
    '--tuples-only',
    '--no-align',
    '-c',
    query,
  ])
    .toString()
    .trim();
}
async function waitForApi() {
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      if ((await fetch('http://127.0.0.1:8080/backend/api/v1/health')).ok)
        return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('The disposable Compose API did not become ready.');
}
try {
  await writeFile(
    override,
    'services:\n  api:\n    image: signaldock-api:test\n  worker:\n    image: signaldock-api:test\n  web:\n    image: signaldock-web:test\n',
    { mode: 0o600 },
  );
  docker([
    ...compose,
    'up',
    '--no-build',
    '--wait',
    '--wait-timeout',
    '90',
    'db',
  ]);
  sql('signaldock', 'CREATE DATABASE sd_actual_target');
  const target = new URL(originalUrl);
  target.pathname = '/sd_actual_target';
  const active = original
    .replace(/^DATABASE_URL=.*$/m, 'DATABASE_URL=' + target.href)
    .replace(/^SIGNALDOCK_BASE_PATH=.*$/m, 'SIGNALDOCK_BASE_PATH=/backend')
    .replace(/^WEB_BASE_PATH=.*$/m, 'WEB_BASE_PATH=/station')
    .replace(
      /^SIGNALDOCK_MEDIA_TRANSPORT=.*$/m,
      'SIGNALDOCK_MEDIA_TRANSPORT=websocket',
    )
    .replace(
      /^SIGNALDOCK_ALLOWED_ORIGINS=.*$/m,
      'SIGNALDOCK_ALLOWED_ORIGINS=http://127.0.0.1:8080',
    )
    .replace(
      /^SIGNALDOCK_COOKIE_ORIGIN=.*$/m,
      'SIGNALDOCK_COOKIE_ORIGIN=http://127.0.0.1:8080',
    );
  await writeFile(privateEnv, active, { mode: 0o600 });
  docker([
    ...compose,
    'up',
    '--no-build',
    '--wait',
    '--wait-timeout',
    '90',
    'api',
    'worker',
    'web',
  ]);
  await waitForApi();
  // Exercise a real upgrade through the bundled proxy, including a distinct API prefix.
  // A deliberately nonexistent enrollment is then closed without receiving audio.
  await new Promise((resolve, reject) => {
    const request = httpRequest(
      `http://127.0.0.1:8080/backend/api/v1/media/socket/${crypto.randomUUID()}`,
      {
        headers: {
          Connection: 'Upgrade',
          Upgrade: 'websocket',
          'Sec-WebSocket-Version': '13',
          'Sec-WebSocket-Key': randomBytes(16).toString('base64'),
          'Sec-WebSocket-Protocol':
            'signaldock.pcm.v1, ticket.' + 'x'.repeat(43),
          Origin: 'http://127.0.0.1:8080',
        },
      },
    );
    request.setTimeout(10000, () =>
      request.destroy(new Error('WebSocket proxy upgrade timed out.')),
    );
    request.on('error', reject);
    request.on('response', (response) => {
      response.resume();
      reject(
        new Error(
          'Proxy did not upgrade the audio socket: ' + response.statusCode,
        ),
      );
    });
    request.on('upgrade', (response, socket) => {
      socket.on('error', () => undefined);
      try {
        assert.equal(response.statusCode, 101);
        assert.equal(
          response.headers['sec-websocket-protocol'],
          'signaldock.pcm.v1',
        );
        socket.destroy();
        resolve();
      } catch (error) {
        socket.destroy();
        reject(error);
      }
    });
    request.end();
  });
  const apiContainer = docker([...compose, 'ps', '--quiet', 'api'])
    .toString()
    .trim();
  assert(/^[a-f0-9]{12,64}$/.test(apiContainer));
  execFileSync(process.execPath, ['scripts/checks/container-station.mjs'], {
    env: {
      ...env,
      SIGNALDOCK_CONTAINER_TEST_NAME: apiContainer,
      SIGNALDOCK_CONTAINER_TEST_URL: 'http://127.0.0.1:8080/backend/api/v1/',
      SIGNALDOCK_CONTAINER_TEST_WEB_URL: 'http://127.0.0.1:8080/station/',
    },
    stdio: 'inherit',
  });
  // A changed .env must not redirect backup away from the running station's database.
  await writeFile(
    privateEnv,
    active.replace(/^DATABASE_URL=.*$/m, 'DATABASE_URL=' + originalUrl),
    { mode: 0o600 },
  );
  const backup = join(temporary, 'backup');
  execFileSync('bash', ['scripts/ops/backup.sh', backup], {
    env,
    stdio: 'inherit',
  });
  const dump = await readFile(join(backup, 'database.dump'));
  const contents = docker(
    [...compose, 'exec', '-T', 'db', 'pg_restore', '--list'],
    dump,
  ).toString();
  assert(
    contents.includes('sd_users') && contents.includes('sd_communications'),
    'Backup must contain the deployed target database, not the empty bundled default.',
  );
  sql('signaldock', 'CREATE DATABASE sd_restored_target');
  docker(
    [
      ...compose,
      'exec',
      '-T',
      'db',
      'pg_restore',
      '-U',
      'signaldock',
      '-d',
      'sd_restored_target',
      '--no-owner',
      '--no-privileges',
      '--exit-on-error',
    ],
    dump,
  );
  assert.equal(
    sql(
      'sd_restored_target',
      'SELECT (SELECT count(*) FROM sd_users),(SELECT count(*) FROM sd_communications)',
    ),
    '1|1',
  );
  const archive = execFileSync(
    'tar',
    ['-tzf', join(backup, 'instance-data.tar.gz')],
    { encoding: 'utf8' },
  );
  assert(
    archive.includes('./identity.json') &&
      archive.includes('./station-secrets.json'),
  );
  const running = new Set(
    docker([...compose, 'ps', '--services', '--status', 'running'])
      .toString()
      .trim()
      .split('\n'),
  );
  assert(running.has('api') && running.has('worker'));
  await waitForApi();
  failed = false;
  console.log(
    'Compose acceptance passed: actual API/worker deployment, configured database backup despite changed .env, restored rows, private identity archive and prior running states.',
  );
} finally {
  if (failed) {
    try {
      process.stdout.write(
        docker([...compose, 'logs', '--no-color', '--tail', '80']),
      );
    } catch {}
  }
  try {
    docker([...compose, 'down', '--volumes', '--remove-orphans']);
  } finally {
    await writeFile(privateEnv, original, { mode: 0o600 });
    await rm(temporary, { recursive: true, force: true });
  }
}
