import type { ConfigContext, ExpoConfig } from 'expo/config';

export default ({ config }: ConfigContext): ExpoConfig => {
  const baseUrl = process.env['SIGNALDOCK_WEB_BASE_PATH'] ?? '';
  if (!/^(?:\/[a-zA-Z0-9_-]+)*$/.test(baseUrl))
    throw new Error(
      'SIGNALDOCK_WEB_BASE_PATH must contain path segments only.',
    );
  return {
    ...config,
    name: config.name ?? 'SignalDock',
    slug: config.slug ?? 'signaldock',
    experiments: { ...config.experiments, baseUrl },
  };
};
