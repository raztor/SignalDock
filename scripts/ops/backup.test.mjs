import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  copyFile,
  rm,
  stat,
  readdir,
  access,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';

const temporary = [];
afterEach(async () => {
  await Promise.all(
    temporary
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});
const id = 'a'.repeat(64),
  workerId = 'b'.repeat(64),
  image = `sha256:${'1'.repeat(64)}`;
const source = dirname(fileURLToPath(import.meta.url));
const randomPassword = () => randomBytes(24).toString('base64url');
function databaseUrl(
  host = 'external.example',
  database = 'actual_database',
  query = '',
) {
  return (
    'postgresql://' +
    'backup_user:' +
    encodeURIComponent(randomPassword()) +
    '@' +
    host +
    '/' +
    database +
    (query ? '?' + query : '')
  );
}
async function fixture(options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'signaldock-backup-test-'));
  temporary.push(root);
  await mkdir(join(root, 'scripts', 'ops'), { recursive: true });
  await mkdir(join(root, 'bin'));
  await mkdir(join(root, 'private-tmp'));
  for (const file of ['backup.sh', 'backup-config.mjs'])
    await copyFile(join(source, file), join(root, 'scripts', 'ops', file));
  const password =
    randomPassword() + '\n$(touch ' + join(root, 'must-not-exist') + ')=!';
  const url =
    options.databaseUrl ??
    `postgresql://backup_user:${encodeURIComponent(password)}@external.example:6543/actual_database?sslmode=require&application_name=SignalDock%20backup`;
  const container = (
    databaseUrl,
    mount = 'station-data',
    directory = '/data',
  ) => ({
    Image: image,
    Config: {
      Env: [`DATABASE_URL=${databaseUrl}`, `SIGNALDOCK_DATA_DIR=${directory}`],
    },
    Mounts: [
      {
        Destination: '/data',
        Type: 'volume',
        Name: mount,
        Source: `/volumes/${mount}`,
        RW: true,
      },
    ],
  });
  await writeFile(
    join(root, 'api.json'),
    JSON.stringify([
      container(url, 'station-data', options.dataDirectory ?? '/data'),
    ]),
    { mode: 0o600 },
  );
  await writeFile(
    join(root, 'worker.json'),
    JSON.stringify([
      container(
        options.workerUrl ?? url,
        options.workerMount ?? 'station-data',
      ),
    ]),
    { mode: 0o600 },
  );
  await writeFile(
    join(root, 'docker.cjs'),
    `#!/usr/bin/env node
const fs=require('node:fs');const cp=require('node:child_process');const path=require('node:path');const root=process.env.BACKUP_MOCK_ROOT;const args=process.argv.slice(2);fs.appendFileSync(path.join(root,'calls.jsonl'),JSON.stringify(args)+'\\n',{mode:0o600});
if(args[0]==='inspect'){process.stdout.write(fs.readFileSync(path.join(root,args[1]==='${id}'?'api.json':'worker.json')));process.exit(0);}
if(args[0]==='run'){if(process.env.BACKUP_MOCK_FAILURE==='archive'){console.error('Fixture archive failed.');process.exit(29);}process.stdout.write('private-volume-archive');process.exit(0);}
if(args[0]!=='compose')process.exit(90);
if(args.includes('ps')){if(args.includes('--services'))console.log(JSON.parse(process.env.BACKUP_MOCK_RUNNING).join('\\n'));else if(args.at(-1)==='api')console.log('${id}');else if(process.env.BACKUP_MOCK_WORKER!=='absent')console.log('${workerId}');process.exit(0);}
if(args.includes('stop'))process.exit(process.env.BACKUP_MOCK_FAILURE==='stop'?17:0);
if(args.includes('start'))process.exit(process.env.BACKUP_MOCK_FAILURE==='restart'?19:0);
if(args.includes('exec')){if(args.includes('--version'))process.exit(process.env.BACKUP_MOCK_FAILURE==='preflight'?31:0);const script=args.at(-1);const input=fs.readFileSync(0);const result=cp.spawnSync('bash',['-c',script],{input,env:process.env});process.stdout.write(result.stdout);process.stderr.write(result.stderr);process.exit(result.status??91);}
process.exit(92);
`,
    { mode: 0o700 },
  );
  await writeFile(
    join(root, 'bin', 'docker'),
    '#!/usr/bin/env bash\nexec "$BACKUP_TEST_NODE" -- "$BACKUP_MOCK_ROOT/docker.cjs" "$@"\n',
    { mode: 0o700 },
  );
  await writeFile(
    join(root, 'bin', 'pg_dump'),
    `#!/usr/bin/env node
const fs=require('node:fs');const path=require('node:path');const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>key.startsWith('PG')));fs.writeFileSync(path.join(process.env.BACKUP_MOCK_ROOT,'connection.json'),JSON.stringify({env,args:process.argv.slice(2)}),{mode:0o600});if(process.env.BACKUP_MOCK_FAILURE==='dump'){console.error('Fixture dump failed.');process.exit(23);}process.stdout.write('dump-of-'+env.PGHOST+'/'+env.PGDATABASE);
`,
    { mode: 0o700 },
  );
  const destination = join(root, 'backup');
  const run = () =>
    spawnSync(
      'bash',
      [join(root, 'scripts', 'ops', 'backup.sh'), destination],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${join(root, 'bin')}:${dirname(process.execPath)}:${process.env.PATH}`,
          TMPDIR: join(root, 'private-tmp'),
          BACKUP_TEST_NODE: process.execPath,
          BACKUP_MOCK_ROOT: root,
          BACKUP_MOCK_RUNNING: JSON.stringify(
            options.running ?? ['api', 'worker'],
          ),
          BACKUP_MOCK_FAILURE: options.failure ?? '',
          BACKUP_MOCK_WORKER: options.worker ?? 'present',
          ...options.clientEnvironment,
        },
      },
    );
  return {
    root,
    destination,
    password,
    privateValues: [
      password,
      ...[url, options.workerUrl].filter(Boolean).flatMap((value) => {
        const parsed = new URL(value);
        return [
          decodeURIComponent(parsed.password),
          parsed.searchParams.get('password'),
        ].filter(Boolean);
      }),
    ],
    url,
    run,
    calls: async () =>
      JSON.parse(
        '[' +
          (await readFile(join(root, 'calls.jsonl'), 'utf8'))
            .trim()
            .split('\n')
            .join(',') +
          ']',
      ),
  };
}
function action(calls, name) {
  return calls.filter((args) => args[0] === 'compose' && args.includes(name));
}
async function assertPrivate(f, result) {
  const logs = await readFile(join(f.root, 'calls.jsonl'), 'utf8');
  for (const secret of [
    ...f.privateValues.flatMap((value) => [
      value,
      value.split('\n')[0],
      encodeURIComponent(value),
    ]),
    f.url,
  ]) {
    assert(!result.stdout.includes(secret));
    assert(!result.stderr.includes(secret));
    assert(!logs.includes(secret));
  }
  assert.deepEqual(await readdir(join(f.root, 'private-tmp')), []);
}

test('backs up the deployed external URL using private stdin and the actual API volume', async () => {
  const f = await fixture();
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  const captured = JSON.parse(
    await readFile(join(f.root, 'connection.json'), 'utf8'),
  );
  assert.deepEqual(captured.env, {
    PGHOST: 'external.example',
    PGPORT: '6543',
    PGDATABASE: 'actual_database',
    PGUSER: 'backup_user',
    PGPASSWORD: f.password,
    PGCONNECT_TIMEOUT: '10',
    PGSSLMODE: 'require',
    PGAPPNAME: 'SignalDock backup',
  });
  assert.deepEqual(captured.args, ['--format=custom', '--no-password']);
  const calls = await f.calls();
  const archive = calls.find((args) => args[0] === 'run');
  assert(archive.includes(`${id}:ro`));
  assert(archive.includes(image));
  assert.deepEqual(action(calls, 'start')[0].slice(-2), ['api', 'worker']);
  assert.equal((await stat(f.destination)).mode & 0o777, 0o700);
  for (const file of ['database.dump', 'instance-data.tar.gz'])
    assert.equal((await stat(join(f.destination, file))).mode & 0o777, 0o600);
  await assert.rejects(access(join(f.root, 'must-not-exist')));
  await assertPrivate(f, result);
});
test('supports the generated bundled URL and preserves a stopped worker', async () => {
  const f = await fixture({
    databaseUrl: databaseUrl('db:5432', 'signaldock'),
    running: ['api'],
  });
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  const calls = await f.calls();
  assert.deepEqual(action(calls, 'start')[0].slice(-1), ['api']);
  const captured = JSON.parse(
    await readFile(join(f.root, 'connection.json'), 'utf8'),
  );
  assert.equal(captured.env.PGHOST, 'db');
  assert.equal(captured.env.PGDATABASE, 'signaldock');
  await assertPrivate(f, result);
});
for (const [label, options] of [
  [
    'database mismatch',
    { workerUrl: databaseUrl('other.example', 'different') },
  ],
  ['volume mismatch', { workerMount: 'another-station' }],
  ['unsupported data directory', { dataDirectory: '/custom-data' }],
  [
    'unsupported URL query',
    {
      databaseUrl: databaseUrl(
        'external.example',
        'database',
        'password=' + encodeURIComponent(randomPassword()),
      ),
    },
  ],
])
  test(`rejects ${label} before stopping services`, async () => {
    const f = await fixture(options);
    const result = f.run();
    assert.notEqual(result.status, 0);
    const calls = await f.calls();
    assert.equal(action(calls, 'stop').length, 0);
    assert.equal(action(calls, 'start').length, 0);
    await assert.rejects(access(f.destination));
    await assertPrivate(f, result);
  });
for (const [failure, code] of [
  ['dump', 23],
  ['archive', 29],
  ['stop', 17],
])
  test(`restores prior service state after ${failure} failure`, async () => {
    const f = await fixture({ failure, running: ['worker'] });
    const result = f.run();
    assert.equal(result.status, code, result.stderr);
    const calls = await f.calls();
    assert.equal(action(calls, 'stop').length, 1);
    assert.deepEqual(action(calls, 'start')[0].slice(-1), ['worker']);
    assert(!result.stdout.includes('backed up'));
    await assertPrivate(f, result);
  });
test('fails client preflight without entering maintenance', async () => {
  const f = await fixture({ failure: 'preflight' });
  const result = f.run();
  assert.equal(result.status, 31);
  assert.equal(action(await f.calls(), 'stop').length, 0);
  assert.equal(action(await f.calls(), 'start').length, 0);
  await assertPrivate(f, result);
});
test('reports restart failure after completing both protected archives', async () => {
  const f = await fixture({ failure: 'restart' });
  const result = f.run();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /could not restart/);
  assert.equal(
    await readFile(join(f.destination, 'instance-data.tar.gz'), 'utf8'),
    'private-volume-archive',
  );
  await assertPrivate(f, result);
});
test('backs up an existing API with no worker container', async () => {
  const f = await fixture({ worker: 'absent', running: ['api'] });
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  await assertPrivate(f, result);
});
test('ignores conflicting libpq defaults from the client container', async () => {
  const f = await fixture({
    clientEnvironment: {
      PGHOSTADDR: '192.0.2.99',
      PGSERVICE: 'foreign-service',
      PGPASSWORD: randomPassword(),
      SHELLOPTS: 'xtrace',
    },
  });
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  const captured = JSON.parse(
    await readFile(join(f.root, 'connection.json'), 'utf8'),
  );
  assert.equal(captured.env.PGHOSTADDR, undefined);
  assert.equal(captured.env.PGSERVICE, undefined);
  assert.equal(captured.env.PGPASSWORD, f.password);
  await assertPrivate(f, result);
});
test('leaves both services stopped when neither was running', async () => {
  const f = await fixture({ running: [] });
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(action(await f.calls(), 'start').length, 0);
  await assertPrivate(f, result);
});
test('setup forwards optional deployment settings without replacing existing secrets', async () => {
  const f = await fixture();
  await mkdir(join(f.root, 'deploy'));
  await copyFile(
    join(source, 'setup-deploy.mjs'),
    join(f.root, 'scripts', 'ops', 'setup-deploy.mjs'),
  );
  const run = () =>
    spawnSync(
      process.execPath,
      [join(f.root, 'scripts', 'ops', 'setup-deploy.mjs')],
      { encoding: 'utf8' },
    );
  assert.equal(run().status, 0);
  const path = join(f.root, 'deploy', '.env');
  const before = await readFile(path, 'utf8');
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.match(before, /^SIGNALDOCK_RELAY_URL=$/m);
  assert.match(before, /^SIGNALDOCK_DRIVER_CREDENTIALS_FILE=$/m);
  assert.equal(run().status, 0);
  assert.equal(await readFile(path, 'utf8'), before);
});
for (const host of [
  '127.0.0.1',
  '127.5.6.7',
  '127.1',
  '2130706433',
  '0x7f000001',
  '0177.0.0.1',
  '[::1]',
  '[0:0:0:0:0:0:0:1]',
  '[::ffff:127.0.0.1]',
  'localhost',
  'LOCALHOST.',
  'localhost.localdomain',
  'application.localhost',
  '%6cocalhost',
  '0.0.0.0',
  '[::]',
  '[::ffff:0.0.0.0]',
])
  test(`rejects namespace-dependent database host ${host} before maintenance without disclosing its random password`, async () => {
    const f = await fixture({ databaseUrl: databaseUrl(host) });
    const result = f.run();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Loopback and localhost.*custom backup/);
    const calls = await f.calls();
    assert.equal(action(calls, 'stop').length, 0);
    assert.equal(action(calls, 'start').length, 0);
    await assert.rejects(access(f.destination));
    await assertPrivate(f, result);
  });
