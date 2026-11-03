import { SignalDockClient } from '@signaldock/client-sdk';
import type { RecentServer, ServerInfo } from '@signaldock/contracts';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  HEALTH_TIMEOUT_MS,
  healthFromError,
  healthFromInfo,
  type StationHealth,
} from './server-model';

export interface StationHealthState {
  /** Keyed by canonical base URL. Missing means "not checked yet". */
  health: Readonly<Record<string, StationHealth>>;
  /** Checks one station again, or every station when no URL is given. */
  refresh: (baseUrl?: string) => void;
  /** Records a successful discovery made elsewhere (e.g. while connecting). */
  markOnline: (baseUrl: string, info: ServerInfo) => void;
}

/**
 * Live health for saved stations. It uses the same discovery request (and the
 * same pinned-identity check) as server selection, with a 4 s timeout, so a
 * card never claims a station is online when connecting to it would fail.
 */
export function useStationHealth(
  servers: readonly RecentServer[],
): StationHealthState {
  const [health, setHealth] = useState<Record<string, StationHealth>>({});
  const checks = useRef(new Map<string, AbortController>());
  const latest = useRef(servers);
  latest.current = servers;

  const check = useCallback((server: RecentServer) => {
    const key = server.baseUrl;
    checks.current.get(key)?.abort();
    const controller = new AbortController();
    checks.current.set(key, controller);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, HEALTH_TIMEOUT_MS);
    setHealth((previous) => ({ ...previous, [key]: { state: 'checking' } }));
    const settle = (next: StationHealth) => {
      clearTimeout(timer);
      if (checks.current.get(key) !== controller) return;
      checks.current.delete(key);
      setHealth((previous) => ({ ...previous, [key]: next }));
    };
    void (async () => {
      try {
        const info = await new SignalDockClient(key).discover({
          signal: controller.signal,
          expected: server,
        });
        settle(healthFromInfo(info));
      } catch (failure) {
        // A newer check or unmount aborted this one; leave its state alone.
        if (controller.signal.aborted && !timedOut) {
          clearTimeout(timer);
          return;
        }
        settle(healthFromError(failure, timedOut));
      }
    })();
  }, []);

  const refresh = useCallback(
    (baseUrl?: string) => {
      for (const server of latest.current)
        if (!baseUrl || server.baseUrl === baseUrl) check(server);
    },
    [check],
  );

  const markOnline = useCallback((baseUrl: string, info: ServerInfo) => {
    checks.current.get(baseUrl)?.abort();
    checks.current.delete(baseUrl);
    setHealth((previous) => ({ ...previous, [baseUrl]: healthFromInfo(info) }));
  }, []);

  // Check stations that appear in the list; forget results for removed ones.
  const signature = servers
    .map((server) => `${server.baseUrl}|${server.identity.keyId}`)
    .join('\n');
  useEffect(() => {
    const known = new Set(latest.current.map((server) => server.baseUrl));
    for (const [key, controller] of checks.current)
      if (!known.has(key)) {
        controller.abort();
        checks.current.delete(key);
      }
    setHealth((previous) =>
      Object.fromEntries(
        Object.entries(previous).filter(([key]) => known.has(key)),
      ),
    );
    for (const server of latest.current) check(server);
  }, [signature, check]);

  useEffect(() => {
    const active = checks.current;
    return () => {
      for (const controller of active.values()) controller.abort();
      active.clear();
    };
  }, []);

  return { health, refresh, markOnline };
}
