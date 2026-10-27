export function normalizeBasePath(input: string): string {
  if (!input || input === '/') return '';
  if (!/^\/(?:[a-zA-Z0-9_-]+\/?)+$/.test(input))
    throw new Error('Base path must contain simple slash-separated segments.');
  return input.replace(/\/+$/, '');
}
