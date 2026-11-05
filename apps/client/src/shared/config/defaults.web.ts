import { defaultWebServerUrl } from './default-server-url';

export const DEFAULT_SERVER_URL = defaultWebServerUrl(
  typeof window === 'undefined' ? undefined : window.location.origin,
  process.env.EXPO_PUBLIC_SIGNALDOCK_API_BASE_PATH ?? '',
  __DEV__,
);
