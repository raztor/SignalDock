import { describe, expect, it } from 'vitest';
import { defaultWebServerUrl } from './default-server-url';

describe('the deployed web client station address', () => {
  it('uses the public web origin for the bundled API', () => {
    expect(defaultWebServerUrl('https://signaldock.raztor.cl', '', false)).toBe(
      'https://signaldock.raztor.cl',
    );
  });
  it('uses the API prefix independently of the web page path', () => {
    expect(
      defaultWebServerUrl('https://radio.example', '/backend', false),
    ).toBe('https://radio.example/backend');
  });
  it('preserves the loopback development API and non-browser fallback', () => {
    expect(defaultWebServerUrl('http://localhost:8081', '', true)).toBe(
      'http://localhost:3000',
    );
    expect(defaultWebServerUrl(undefined, '', false)).toBe(
      'http://localhost:3000',
    );
  });
  it('rejects an API prefix containing a query or another origin', () => {
    for (const prefix of ['https://other.example', '/backend?query', '/x/../y'])
      expect(() =>
        defaultWebServerUrl('https://radio.example', prefix, false),
      ).toThrow('path segments');
  });
});
