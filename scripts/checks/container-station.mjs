import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
const base =
  process.env.SIGNALDOCK_CONTAINER_TEST_URL ??
  'http://127.0.0.1:3000/station/api/v1/';
const container =
  process.env.SIGNALDOCK_CONTAINER_TEST_NAME ?? 'signaldock-api-test';
const radioId = crypto.randomUUID();
const password = crypto.randomUUID() + crypto.randomUUID();
async function call(path, token, method = 'GET', body) {
  const response = await fetch(new URL(path, base), {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const value = response.status === 204 ? undefined : await response.json();
  if (!response.ok)
    throw new Error(
      `Container ${method} ${path}: ${response.status} ${value?.code}`,
    );
  return value;
}
async function waitFor(check) {
  const until = Date.now() + 30000;
  while (true) {
    try {
      if (await check()) return;
    } catch {
      /* Wait for container startup. */
    }
    if (Date.now() > until) throw new Error('Container acceptance timed out.');
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}
await waitFor(() => call('health').then(() => true));
const info = await call('server-info');
assert.equal(info.features.authentication, 'local');
const setupToken = execFileSync(
  'docker',
  [
    'exec',
    container,
    'node',
    '-e',
    "process.stdout.write(JSON.parse(require('fs').readFileSync('/data/station-secrets.json','utf8')).setupToken)",
  ],
  { encoding: 'utf8' },
);
await call('auth/bootstrap', undefined, 'POST', {
  setupToken,
  username: 'container-admin',
  password,
});
const login = () =>
  call('auth/login', undefined, 'POST', {
    username: 'container-admin',
    password,
    sessionMode: 'token',
  });
let session = await login();
await call('radios', session.accessToken, 'POST', {
  radioId,
  displayName: 'Container fixture',
  driverId: 'simulator.tunable',
  resourceGroupIds: [],
  enabled: true,
  config: {},
});
assert.deepEqual(await call('radios', session.accessToken), []);
await call(`admin/users/${session.user.id}`, session.accessToken, 'PATCH', {
  radioPermissions: [
    {
      radioId,
      permissions: [
        'radio.listen',
        'radio.control',
        'history.read',
        'history.write',
        'notifications.read',
      ],
    },
  ],
});
session = await login();
await waitFor(() =>
  call(`radios/${radioId}`, session.accessToken).then(
    (radio) => radio.health.state === 'connected',
  ),
);
const before = await call(`radios/${radioId}`, session.accessToken);
const lease = await call(
  `radios/${radioId}/control`,
  session.accessToken,
  'POST',
);
await call(`radios/${radioId}/operations`, session.accessToken, 'POST', {
  context: {
    operationId: crypto.randomUUID(),
    radioId,
    generation: before.snapshot.generation,
    expectedRevision: before.snapshot.revision,
    controlGrant: lease.grantId,
    deadline: new Date(Date.now() + 10000).toISOString(),
  },
  tuning: { rxHz: 147540000, mode: 'FM' },
});
assert.equal(
  (await call(`radios/${radioId}`, session.accessToken)).snapshot.observedTuning
    .rxHz,
  147540000,
);
await call('communications/notes', session.accessToken, 'POST', {
  radioId,
  text: 'Container installation fixture.',
});
await waitFor(() =>
  call('notifications', session.accessToken).then((page) =>
    page.items.some((item) => item.category === 'communication'),
  ),
);
execFileSync('docker', ['restart', container], { stdio: 'pipe' });
await waitFor(() => call('health').then(() => true));
assert.equal((await call('server-info')).instanceId, info.instanceId);
session = await login();
await waitFor(() =>
  call(`radios/${radioId}`, session.accessToken).then(
    (radio) => radio.health.state === 'connected',
  ),
);
const after = await call(`radios/${radioId}`, session.accessToken);
assert.equal(after.control, null);
assert.equal(after.snapshot.txState, 'idle');
assert.notEqual(after.snapshot.generation, before.snapshot.generation);
assert.equal(
  (await call('communications', session.accessToken)).items.length,
  1,
);
console.log(
  'Container acceptance passed: clean bootstrap, explicit grants, tuning, external worker notification fanout, prefix routing, persistent identity/history and no restored control.',
);
