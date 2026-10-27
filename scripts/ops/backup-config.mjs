import { readFile, writeFile } from 'node:fs/promises';

const queryEnvironment = new Map([
  ['sslmode', 'PGSSLMODE'],
  ['sslrootcert', 'PGSSLROOTCERT'],
  ['sslcert', 'PGSSLCERT'],
  ['sslkey', 'PGSSLKEY'],
  ['sslcrl', 'PGSSLCRL'],
  ['sslcrldir', 'PGSSLCRLDIR'],
  ['connect_timeout', 'PGCONNECT_TIMEOUT'],
  ['application_name', 'PGAPPNAME'],
  ['options', 'PGOPTIONS'],
  ['target_session_attrs', 'PGTARGETSESSIONATTRS'],
  ['channel_binding', 'PGCHANNELBINDING'],
  ['gssencmode', 'PGGSSENCMODE'],
]);
class BackupConfigurationError extends Error {}
function fail(message) {
  throw new BackupConfigurationError(message);
}
function localDatabaseHost(host) {
  const normalized = host.toLowerCase().replace(/\.+$/, '');
  if (
    [
      'localhost',
      'localhost.localdomain',
      'localhost6',
      'localhost6.localdomain6',
      'ip6-localhost',
      'ip6-loopback',
    ].includes(normalized) ||
    normalized.endsWith('.localhost')
  )
    return true;
  // HTTP's IP parser canonicalizes shorthand, decimal, octal and hexadecimal IPv4.
  let address = normalized;
  try {
    address = new URL(
      `http://${normalized.includes(':') ? `[${normalized}]` : normalized}`,
    ).hostname.replace(/^\[|\]$/g, '');
  } catch {
    /* Non-IP DNS names remain unchanged. */
  }
  if (
    address === '::1' ||
    address === '::' ||
    address === '0.0.0.0' ||
    address.startsWith('127.')
  )
    return true;
  const mapped = /^::(?:ffff:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(address);
  return Boolean(
    mapped &&
    (Number.parseInt(mapped[1], 16) >>> 8 === 127 ||
      (Number.parseInt(mapped[1], 16) === 0 &&
        Number.parseInt(mapped[2], 16) === 0)),
  );
}
function environment(container) {
  const result = new Map();
  if (!Array.isArray(container?.Config?.Env))
    fail('Container environment metadata is unavailable.');
  for (const item of container.Config.Env) {
    if (typeof item !== 'string' || !item.includes('='))
      fail('Container environment metadata is invalid.');
    const separator = item.indexOf('=');
    const key = item.slice(0, separator);
    if (result.has(key))
      fail('Duplicate container environment settings are unsupported.');
    result.set(key, item.slice(separator + 1));
  }
  return result;
}
function dataMount(container, env) {
  if (env.get('SIGNALDOCK_DATA_DIR') !== '/data')
    fail('Backup requires the deployed station data directory to be /data.');
  const mounts = container?.Mounts?.filter(
    (mount) => mount.Destination === '/data',
  );
  if (
    !Array.isArray(mounts) ||
    mounts.length !== 1 ||
    mounts[0].RW !== true ||
    !mounts[0].Source
  )
    fail('A writable deployed /data mount is required.');
  return `${mounts[0].Type}:${mounts[0].Name ?? mounts[0].Source}`;
}
async function inspect(path) {
  let value;
  try {
    value = JSON.parse(await readFile(path, 'utf8'));
  } catch {
    fail('Cannot read deployed container metadata.');
  }
  if (!Array.isArray(value) || value.length !== 1)
    fail('Exactly one deployed service container is required.');
  return value[0];
}
async function main() {
  const [apiPath, workerPath, outputPath] = process.argv.slice(2);
  if (!apiPath || !workerPath || !outputPath)
    fail('Private backup metadata paths are required.');
  const api = await inspect(apiPath);
  const env = environment(api);
  const mount = dataMount(api, env);
  const databaseUrl = env.get('DATABASE_URL');
  if (!databaseUrl) fail('The deployed API has no DATABASE_URL.');
  if (workerPath !== '-') {
    const worker = await inspect(workerPath);
    const workerEnv = environment(worker);
    if (
      workerEnv.get('DATABASE_URL') !== databaseUrl ||
      dataMount(worker, workerEnv) !== mount
    )
      fail(
        'API and worker must use the same database and /data mount before backup.',
      );
  }
  if (!/^sha256:[a-f0-9]{64}$/.test(api.Image ?? ''))
    fail('The deployed API image identity is unavailable.');
  for (const key of [
    'PGSERVICE',
    'PGSERVICEFILE',
    'PGPASSFILE',
    'PGHOSTADDR',
  ]) {
    if (env.get(key))
      fail(
        'External libpq service/passfile/hostaddr settings require a custom backup procedure.',
      );
  }
  let url;
  try {
    url = new URL(databaseUrl);
  } catch {
    fail('The deployed DATABASE_URL is not a supported PostgreSQL URL.');
  }
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    url.hash ||
    !url.hostname ||
    !url.username ||
    url.pathname.length < 2
  )
    fail(
      'Backup requires a PostgreSQL URL with explicit host, user and database.',
    );
  const host = decodeURIComponent(url.hostname).replace(/^\[|\]$/g, '');
  if (localDatabaseHost(host))
    fail(
      'Loopback and localhost database addresses require a custom backup procedure in the API network namespace.',
    );
  const values = new Map([
    ['PGHOST', host],
    ['PGPORT', url.port || env.get('PGPORT') || '5432'],
    ['PGDATABASE', decodeURIComponent(url.pathname.slice(1))],
    ['PGUSER', decodeURIComponent(url.username)],
    [
      'PGPASSWORD',
      decodeURIComponent(url.password) || env.get('PGPASSWORD') || '',
    ],
    ['PGCONNECT_TIMEOUT', '10'],
  ]);
  for (const name of queryEnvironment.values())
    if (env.has(name)) values.set(name, env.get(name));
  const seen = new Set();
  for (const [key, value] of url.searchParams) {
    const name = queryEnvironment.get(key);
    if (!name || seen.has(key))
      fail(
        'DATABASE_URL has unsupported or duplicate connection parameters; use the documented URL settings or a custom backup procedure.',
      );
    seen.add(key);
    values.set(name, value);
  }
  if (
    ![...values.values()].every(
      (value) => typeof value === 'string' && !value.includes('\0'),
    )
  )
    fail('PostgreSQL connection settings cannot contain NUL bytes.');
  if (
    !/^\d+$/.test(values.get('PGPORT')) ||
    Number(values.get('PGPORT')) < 1 ||
    Number(values.get('PGPORT')) > 65535
  )
    fail('PostgreSQL port is invalid.');
  if (
    values.has('PGSSLMODE') &&
    ![
      'disable',
      'allow',
      'prefer',
      'require',
      'verify-ca',
      'verify-full',
    ].includes(values.get('PGSSLMODE'))
  )
    fail(
      'The configured SSL mode is unsupported by the PostgreSQL backup client.',
    );
  if (
    !/^\d+$/.test(values.get('PGCONNECT_TIMEOUT')) ||
    Number(values.get('PGCONNECT_TIMEOUT')) < 1
  )
    fail('Backup requires a positive PostgreSQL connection timeout.');
  // All connection values, including passwords and URI options, travel on private stdin.
  const payload = [...values]
    .map(([key, value]) => `${key}\0${value}\0`)
    .join('');
  await writeFile(outputPath, payload, { flag: 'wx', mode: 0o600 });
  process.stdout.write(
    JSON.stringify({ image: api.Image, directory: '/data' }) + '\n',
  );
}
main().catch((error) => {
  // Never print a URL, container inspection result, parser input, or private value.
  process.stderr.write(
    (error instanceof BackupConfigurationError
      ? error.message
      : 'Cannot prepare private backup configuration.') + '\n',
  );
  process.exitCode = 1;
});
