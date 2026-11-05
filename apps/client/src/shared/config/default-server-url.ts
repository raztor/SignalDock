export function defaultWebServerUrl(
  origin: string | undefined,
  apiBasePath: string,
  development: boolean,
): string {
  if (development || !origin) return 'http://localhost:3000';
  if (!/^(?:\/[a-zA-Z0-9_-]+)*$/.test(apiBasePath))
    throw new Error('The API base path must contain path segments only.');
  return origin + apiBasePath;
}
