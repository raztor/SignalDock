import ts from 'typescript';
import { readdir, readFile } from 'node:fs/promises';

const methods = new Set(['get', 'post', 'put', 'patch', 'delete']);
async function files(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  return (
    await Promise.all(
      entries.map((entry) =>
        entry.isDirectory()
          ? files(`${directory}/${entry.name}`)
          : `${directory}/${entry.name}`,
      ),
    )
  ).flat();
}
/** Derive the endpoint catalog from actual route registration, without guessing vendor schemas. */
export async function implementedPaths() {
  const paths = {};
  const sources = [
    ...(await files('apps/api/src/modules')).filter((path) =>
      path.endsWith('.routes.ts'),
    ),
    'apps/api/src/app/events.ts',
  ];
  for (const path of sources) {
    const source = ts.createSourceFile(
      path,
      await readFile(path, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
    );
    const constants = new Map([['prefix', '/api/v1']]);
    function resolve(expression) {
      if (ts.isStringLiteralLike(expression)) return expression.text;
      if (ts.isIdentifier(expression)) return constants.get(expression.text);
      if (
        ts.isPropertyAccessExpression(expression) &&
        expression.name.text === 'prefix'
      )
        return '/api/v1';
      if (ts.isTemplateExpression(expression)) {
        let value = expression.head.text;
        for (const span of expression.templateSpans) {
          const part = resolve(span.expression);
          if (part === undefined) return undefined;
          value += part + span.literal.text;
        }
        return value;
      }
      return undefined;
    }
    function visit(node) {
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.initializer
      ) {
        const value = resolve(node.initializer);
        if (value !== undefined) constants.set(node.name.text, value);
      }
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        ts.isIdentifier(node.expression.expression) &&
        node.expression.expression.text === 'app' &&
        methods.has(node.expression.name.text) &&
        node.arguments[0]
      ) {
        let route = resolve(node.arguments[0]);
        if (route !== undefined && route.startsWith('/')) {
          if (!route.startsWith('/api/v1/')) route = '/api/v1' + route;
          route = route.replace(/:([a-zA-Z0-9_]+)/g, '{$1}');
          const method = node.expression.name.text;
          const operationId =
            method +
            '_' +
            route.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_|_$/g, '');
          const isPublic =
            /\/auth\/(?:bootstrap|login|refresh|logout)$/.test(route) ||
            /\/(?:server-info|health)$/.test(route);
          const parameters = [...route.matchAll(/\{([^}]+)\}/g)].map(
            (match) => ({
              name: match[1],
              in: 'path',
              required: true,
              schema: { type: 'string', minLength: 1 },
            }),
          );
          const operation = {
            operationId,
            security: isPublic ? [] : [{ bearerAuth: [] }],
            ...(parameters.length ? { parameters } : {}),
            'x-validation-source': path,
            responses: {
              '2XX': {
                description:
                  'Successful response; see the authoritative shared models and linked route validator.',
              },
              default: {
                description: 'Typed SignalDock API error',
                content: {
                  'application/json': {
                    schema: { $ref: '#/components/schemas/ApiError' },
                  },
                },
              },
            },
          };
          if (route.endsWith('/events'))
            operation.responses['2XX'] = {
              description:
                'Authenticated bounded station events; reconnect and fetch current snapshots after interruption.',
              content: { 'text/event-stream': { schema: { type: 'string' } } },
            };
          paths[route] ??= {};
          if (paths[route][method])
            throw new Error(`Duplicate API operation ${method} ${route}`);
          paths[route][method] = operation;
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
  return Object.fromEntries(
    Object.entries(paths).sort(([a], [b]) => a.localeCompare(b)),
  );
}
