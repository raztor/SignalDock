import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
const file = new URL('../../deploy/.env', import.meta.url);
const databasePassword = randomBytes(32).toString('hex');
try {
  await writeFile(
    file,
    [
      `POSTGRES_PASSWORD=${databasePassword}`,
      `DATABASE_URL=postgresql://signaldock:${databasePassword}@db:5432/signaldock`,
      'SIGNALDOCK_DISPLAY_NAME=SignalDock station',
      'SIGNALDOCK_ALLOWED_ORIGINS=http://localhost:8080',
      'SIGNALDOCK_COOKIE_ORIGIN=http://localhost:8080',
      'SIGNALDOCK_BASE_PATH=',
      'WEB_BASE_PATH=',
      'LIVEKIT_URL=',
      'LIVEKIT_INTERNAL_URL=ws://livekit:7880',
      `LIVEKIT_API_KEY=${randomBytes(12).toString('hex')}`,
      `LIVEKIT_API_SECRET=${randomBytes(32).toString('hex')}`,
      '',
    ].join('\n'),
    { flag: 'wx', mode: 0o600 },
  );
  console.log(
    'Created private deploy/.env. Configure media networking before enabling the media profile.',
  );
} catch (error) {
  if (error.code !== 'EEXIST') throw error;
  console.log(
    'deploy/.env already exists; existing credentials were preserved.',
  );
}
