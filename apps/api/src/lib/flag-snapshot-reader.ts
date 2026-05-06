import { queryEnvironmentFlagStates } from '@vexillo/db';
import type { DbClient } from '@vexillo/db';
import { evaluateCountryRule } from './evaluate-country-rule';
import type { FlagBus } from './flag-bus';

/**
 * Applies a country code (captured at SSE-connection time, or fresh per REST
 * request) to a raw snapshot string and returns the client-safe JSON. The
 * optional `rawPayloadOverride` lets the SSE handler pass in payloads delivered
 * by FlagBus listeners without going through the snapshot cache.
 */
export type FlagEvaluator = (
  countryCode: string | null,
  rawPayloadOverride?: string,
) => string;

export interface FlagSnapshotReader {
  /**
   * Read the snapshot for an environment, then geo-evaluate against the given
   * country code. Used by the REST handler — one call per request.
   */
  read(args: {
    orgId: string;
    environmentId: string;
    countryCode: string | null;
  }): Promise<string>;

  /**
   * Build an evaluator bound to an environment. Used by the SSE handler to
   * (a) emit the initial snapshot frame, then (b) re-evaluate every payload
   * pushed through `flagBus.registerListener` against the connection's
   * captured country code.
   */
  openEvaluator(args: {
    orgId: string;
    environmentId: string;
  }): Promise<FlagEvaluator>;

  /**
   * Drop the cached snapshot for an environment. Wired up by callers that
   * own non-toggle invalidation paths (the toggle path goes through
   * `flagBus.publishLocal` and updates the cache there).
   */
  invalidate(environmentId: string): void;
}

type RawSnapshot = {
  flags: Array<{
    key: string;
    enabled: boolean;
    allowedCountries?: string[];
  }>;
};

function evaluateRaw(rawSnapshot: string, countryCode: string | null): string {
  const { flags } = JSON.parse(rawSnapshot) as RawSnapshot;
  return JSON.stringify({
    flags: flags.map((r) => ({
      key: r.key,
      enabled: evaluateCountryRule({
        allowedCountries: r.allowedCountries ?? [],
        countryCode,
        envEnabled: r.enabled,
      }),
    })),
  });
}

export function createFlagSnapshotReader(deps: {
  db: DbClient;
  flagBus: FlagBus;
}): FlagSnapshotReader {
  const { db, flagBus } = deps;

  async function loadFromDb(orgId: string, environmentId: string): Promise<string> {
    const rows = await queryEnvironmentFlagStates(db, orgId, environmentId);
    return JSON.stringify({ flags: rows });
  }

  // Returns the latest raw snapshot for an env, hitting DB only on a cold
  // miss. Stale entries are served immediately and refreshed in the background.
  async function loadRaw(orgId: string, environmentId: string): Promise<string> {
    const cached = flagBus.readSnapshot(environmentId);
    if (cached) {
      if (flagBus.isSnapshotStale(environmentId)) {
        loadFromDb(orgId, environmentId)
          .then((snapshot) => {
            flagBus.cacheSnapshot(environmentId, snapshot);
          })
          .catch(() => {});
      }
      return cached;
    }
    const snapshot = await loadFromDb(orgId, environmentId);
    flagBus.cacheSnapshot(environmentId, snapshot);
    return snapshot;
  }

  return {
    async read({ orgId, environmentId, countryCode }) {
      const raw = await loadRaw(orgId, environmentId);
      return evaluateRaw(raw, countryCode);
    },

    async openEvaluator({ orgId, environmentId }) {
      const initialRaw = await loadRaw(orgId, environmentId);
      return (countryCode, rawPayloadOverride) => {
        const raw = rawPayloadOverride ?? initialRaw;
        return evaluateRaw(raw, countryCode);
      };
    },

    invalidate(environmentId) {
      flagBus.invalidateSnapshot(environmentId);
    },
  };
}
