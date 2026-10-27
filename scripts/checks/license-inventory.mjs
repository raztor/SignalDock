import { readFile, mkdir, writeFile } from 'node:fs/promises';
const lock = JSON.parse(await readFile('package-lock.json', 'utf8'));
const packages = Object.entries(lock.packages)
  .filter(([path, value]) => path.includes('node_modules/') && !value.link)
  .map(([path, value]) => ({
    name: value.name ?? path.split('node_modules/').at(-1),
    version: value.version,
    license: value.license ?? 'REVIEW_REQUIRED',
    developmentOnly: value.dev === true,
    ...(value.integrity ? { integrity: value.integrity } : {}),
  }))
  .sort(
    (a, b) =>
      a.name.localeCompare(b.name) || a.version.localeCompare(b.version),
  );
await mkdir('.local/reports', { recursive: true });
await writeFile(
  '.local/reports/dependency-licenses.json',
  JSON.stringify(
    {
      applicationLicense: 'AGPL-3.0-only',
      packages,
      externalComponents: [
        {
          name: 'benlink',
          source: 'https://github.com/khusmann/benlink',
          license: 'Apache-2.0',
          revision: 'c4b9d22112402ea193d376f412bc028d1778fdb4',
          note: 'See the module README for attribution.',
        },
        {
          name: 'FFmpeg',
          license: 'LGPL/GPL depending on distribution build',
          note: 'Container distribution package includes its own copyright/license inventory.',
        },
      ],
    },
    null,
    2,
  ) + '\n',
);
console.log(
  `Recorded ${packages.length} locked dependencies; ${packages.filter((item) => item.license === 'REVIEW_REQUIRED').length} require license metadata review.`,
);
