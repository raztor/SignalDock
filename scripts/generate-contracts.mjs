import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { compile } from 'json-schema-to-typescript';
import {
  contractSchemas,
  toJsonSchema,
} from '../packages/contracts/dist/index.js';

const schemas = Object.fromEntries(
  Object.entries(contractSchemas).map(([name, schema]) => [
    name,
    toJsonSchema(schema),
  ]),
);
const response = (schema) => ({
  description: 'Successful response',
  content: {
    'application/json': { schema: { $ref: `#/components/schemas/${schema}` } },
  },
});
const openapi = {
  openapi: '3.1.0',
  info: {
    title: 'SignalDock API',
    version: '0.1.0',
    description:
      'Implemented discovery endpoints only. Radio and processing schemas are provisional internal contracts.',
  },
  servers: [{ url: '.' }],
  paths: {
    '/api/v1/server-info': {
      get: {
        operationId: 'getServerInfo',
        security: [],
        responses: { 200: response('ServerInfo') },
      },
    },
    '/api/v1/health': {
      get: {
        operationId: 'getHealth',
        security: [],
        responses: { 200: response('Health') },
      },
    },
  },
  components: { schemas },
};
const banner =
  '// Generated from contract schemas. Run npm run generate:contracts.\n';
const models =
  banner +
  (
    await Promise.all(
      Object.entries(schemas).map(([name, schema]) =>
        compile(schema, name, {
          bannerComment: '',
          additionalProperties: false,
          unknownAny: true,
        }),
      ),
    )
  ).join('\n');
const outputs = {
  'packages/contracts/generated/schemas.json':
    JSON.stringify(schemas, null, 2) + '\n',
  'packages/contracts/generated/openapi.json':
    JSON.stringify(openapi, null, 2) + '\n',
  'packages/contracts/generated/models.d.ts': models,
};
await mkdir('packages/contracts/generated', { recursive: true });
for (const [path, content] of Object.entries(outputs)) {
  if (process.argv.includes('--check')) {
    if ((await readFile(path, 'utf8')) !== content)
      throw new Error(`Generated contract is stale: ${path}`);
  } else {
    await writeFile(path, content);
  }
}
