import { LRUCache } from 'lru-cache';
import {
  insertAuditLog,
  queryEnvironmentFlagStates,
  queryOrgEnvironments,
  queryOrgFlagsWithStates,
  queryOrgMembers,
  queryRemovedOrgMembers,
  type AuditEntry,
  type EnvRef,
  type EnvironmentWithKey,
  type FlagWithStates,
  type MemberRow,
} from '@vexillo/db';
import type { DbClient } from '@vexillo/db';
import type { FlagSnapshotWriter } from '../../lib/flag-snapshots';
import type { SdkAuthenticator } from '../../lib/sdk-authenticator';
import type { OrgContextResolver } from '../../lib/org-context-resolver';

/**
 * The single domain-level alphabet of mutations that affect dashboard caches,
 * the SDK snapshot, the SDK auth cache, or the auth-middleware org context.
 * `commit(event)` dispatches to the right combination of effects per kind —
 * the ordering and the dispatch table live inside FlagOps, not at call sites.
 */
export type DomainEvent =
  | { kind: 'flag.created'; orgId: string; actorId: string; flagId: string; flagKey: string; name: string }
  | { kind: 'flag.updated'; orgId: string; actorId: string; flagId: string; flagKey: string; changes: Record<string, unknown> }
  | { kind: 'flag.deleted'; orgId: string; actorId: string; flagKey: string }
  | { kind: 'flag.toggled'; orgId: string; actorId: string; flagKey: string; environmentId: string; enabled: boolean }
  | { kind: 'flag.country_rules'; orgId: string; actorId: string; flagKey: string; environmentId: string; before: string[]; after: string[] }
  | { kind: 'env.created'; orgId: string; actorId: string; environmentId: string; name: string; slug: string }
  | { kind: 'env.deleted'; orgId: string; actorId: string; environmentId: string }
  | { kind: 'env.origins_updated'; orgId: string; actorId: string; environmentId: string; allowedOrigins: string[] }
  | { kind: 'env.key_rotated'; orgId: string; actorId: string; environmentId: string }
  | { kind: 'member.role_updated'; orgId: string; actorId: string; userId: string; role: 'admin' | 'viewer' }
  | { kind: 'member.removed'; orgId: string; actorId: string; userId: string }
  | { kind: 'member.restored'; orgId: string; actorId: string; userId: string };

export interface FlagOps {
  /**
   * Single entry point for every mutation effect. Per event kind:
   *   - inserts the audit row (atomically with the caller's tx if provided)
   *   - publishes the snapshot via FlagSnapshotWriter (flag/env state-changing kinds)
   *   - busts orgId-keyed list caches
   *   - evicts the SDK auth cache (env.key_rotated / env.origins_updated / env.deleted)
   *   - evicts OrgContextResolver (member.* kinds)
   * Ordering is enforced inside commit and not visible to callers.
   */
  commit(event: DomainEvent, tx?: DbClient): Promise<void>;

  /** Read-through for the four orgId-keyed dashboard list caches. The cache
   *  layout is a private implementation detail of FlagOps. */
  read: {
    flagsWithStates(orgId: string): Promise<{ flags: FlagWithStates[]; environments: EnvRef[] }>;
    environments(orgId: string): Promise<EnvironmentWithKey[]>;
    members(orgId: string): Promise<MemberRow[]>;
    removedMembers(orgId: string): Promise<MemberRow[]>;
  };
}

export interface FlagOpsDeps {
  db: DbClient;
  // Only `publishLocal` is needed — `ingestRemote` stays exclusive to
  // routes/internal so the no-region-loop invariant is structurally enforced
  // at the route boundary (a region-receiving route can't accidentally publish
  // through this module).
  flagSnapshots: { writer: Pick<FlagSnapshotWriter, 'publishLocal'> };
  sdkAuth: Pick<SdkAuthenticator, 'evictByEnvironment'>;
  orgContext: Pick<OrgContextResolver, 'invalidate'>;
  ttlMs?: number;
  max?: number;
}

const DEFAULT_TTL_MS = 30_000;
const DEFAULT_MAX = 200;

export function createFlagOps(deps: FlagOpsDeps): FlagOps {
  const { db, flagSnapshots, sdkAuth, orgContext } = deps;
  const ttl = deps.ttlMs ?? DEFAULT_TTL_MS;
  const max = deps.max ?? DEFAULT_MAX;

  // Four orgId-keyed read-through caches — owned by this module and never
  // exposed. List endpoints route through `read.*`; mutations route through
  // `commit(event)` which is the only thing that calls `.delete()`.
  const flagsCache = new LRUCache<string, { flags: FlagWithStates[]; environments: EnvRef[] }>({ max, ttl });
  const envsCache = new LRUCache<string, EnvironmentWithKey[]>({ max, ttl });
  const membersCache = new LRUCache<string, MemberRow[]>({ max, ttl });
  const removedMembersCache = new LRUCache<string, MemberRow[]>({ max, ttl });

  async function audit(
    entry: AuditEntry,
    tx: DbClient | undefined,
  ): Promise<void> {
    await insertAuditLog(tx ?? db, entry);
  }

  async function publishEnvSnapshot(orgId: string, environmentId: string): Promise<void> {
    const flagStates = await queryEnvironmentFlagStates(db, orgId, environmentId);
    await flagSnapshots.writer.publishLocal(
      environmentId,
      JSON.stringify({ flags: flagStates }),
    );
  }

  async function commit(event: DomainEvent, tx?: DbClient): Promise<void> {
    // Ordering rule: audit first (atomic with caller tx if provided), then
    // publish (so SSE clients see fresh state), then bust local caches (so a
    // concurrent REST reader on this container doesn't return stale).
    switch (event.kind) {
      case 'flag.created': {
        await audit(
          {
            orgId: event.orgId,
            actorId: event.actorId,
            action: 'flag.create',
            targetType: 'flag',
            targetId: event.flagId,
            metadata: { name: event.name, key: event.flagKey },
          },
          tx,
        );
        flagsCache.delete(event.orgId);
        return;
      }
      case 'flag.updated': {
        await audit(
          {
            orgId: event.orgId,
            actorId: event.actorId,
            action: 'flag.update',
            targetType: 'flag',
            targetId: event.flagId,
            metadata: { key: event.flagKey, changes: event.changes },
          },
          tx,
        );
        flagsCache.delete(event.orgId);
        return;
      }
      case 'flag.deleted': {
        await audit(
          {
            orgId: event.orgId,
            actorId: event.actorId,
            action: 'flag.delete',
            targetType: 'flag',
            targetId: event.flagKey,
            metadata: { key: event.flagKey },
          },
          tx,
        );
        flagsCache.delete(event.orgId);
        return;
      }
      case 'flag.toggled': {
        await audit(
          {
            orgId: event.orgId,
            actorId: event.actorId,
            action: 'flag.toggle',
            targetType: 'flag',
            targetId: event.flagKey,
            metadata: { key: event.flagKey, environmentId: event.environmentId, enabled: event.enabled },
          },
          tx,
        );
        await publishEnvSnapshot(event.orgId, event.environmentId);
        flagsCache.delete(event.orgId);
        return;
      }
      case 'flag.country_rules': {
        await audit(
          {
            orgId: event.orgId,
            actorId: event.actorId,
            action: 'flag.country-rules.update',
            targetType: 'flag',
            targetId: event.flagKey,
            metadata: {
              key: event.flagKey,
              environmentId: event.environmentId,
              before: event.before,
              after: event.after,
            },
          },
          tx,
        );
        await publishEnvSnapshot(event.orgId, event.environmentId);
        flagsCache.delete(event.orgId);
        return;
      }
      case 'env.created': {
        await audit(
          {
            orgId: event.orgId,
            actorId: event.actorId,
            action: 'environment.create',
            targetType: 'environment',
            targetId: event.environmentId,
            metadata: { name: event.name, slug: event.slug },
          },
          tx,
        );
        envsCache.delete(event.orgId);
        flagsCache.delete(event.orgId);
        return;
      }
      case 'env.deleted': {
        await audit(
          {
            orgId: event.orgId,
            actorId: event.actorId,
            action: 'environment.delete',
            targetType: 'environment',
            targetId: event.environmentId,
          },
          tx,
        );
        // Required, not optional: a deleted environment must drop any cached
        // SDK auth entry — otherwise its API key keeps authenticating until
        // the auth cache TTL expires.
        sdkAuth.evictByEnvironment(event.environmentId);
        envsCache.delete(event.orgId);
        flagsCache.delete(event.orgId);
        return;
      }
      case 'env.origins_updated': {
        await audit(
          {
            orgId: event.orgId,
            actorId: event.actorId,
            action: 'environment.update_origins',
            targetType: 'environment',
            targetId: event.environmentId,
            metadata: { allowedOrigins: event.allowedOrigins },
          },
          tx,
        );
        sdkAuth.evictByEnvironment(event.environmentId);
        envsCache.delete(event.orgId);
        return;
      }
      case 'env.key_rotated': {
        await audit(
          {
            orgId: event.orgId,
            actorId: event.actorId,
            action: 'environment.rotate_key',
            targetType: 'apiKey',
            targetId: event.environmentId,
          },
          tx,
        );
        sdkAuth.evictByEnvironment(event.environmentId);
        envsCache.delete(event.orgId);
        return;
      }
      case 'member.role_updated': {
        await audit(
          {
            orgId: event.orgId,
            actorId: event.actorId,
            action: 'member.update_role',
            targetType: 'member',
            targetId: event.userId,
            metadata: { role: event.role },
          },
          tx,
        );
        orgContext.invalidate(event.orgId, event.userId);
        membersCache.delete(event.orgId);
        removedMembersCache.delete(event.orgId);
        return;
      }
      case 'member.removed': {
        await audit(
          {
            orgId: event.orgId,
            actorId: event.actorId,
            action: 'member.remove',
            targetType: 'member',
            targetId: event.userId,
          },
          tx,
        );
        orgContext.invalidate(event.orgId, event.userId);
        membersCache.delete(event.orgId);
        removedMembersCache.delete(event.orgId);
        return;
      }
      case 'member.restored': {
        await audit(
          {
            orgId: event.orgId,
            actorId: event.actorId,
            action: 'member.restore',
            targetType: 'member',
            targetId: event.userId,
          },
          tx,
        );
        orgContext.invalidate(event.orgId, event.userId);
        membersCache.delete(event.orgId);
        removedMembersCache.delete(event.orgId);
        return;
      }
    }
  }

  return {
    commit,
    read: {
      async flagsWithStates(orgId) {
        const hit = flagsCache.get(orgId);
        if (hit) return hit;
        const result = await queryOrgFlagsWithStates(db, orgId);
        flagsCache.set(orgId, result);
        return result;
      },
      async environments(orgId) {
        const hit = envsCache.get(orgId);
        if (hit) return hit;
        const result = await queryOrgEnvironments(db, orgId);
        envsCache.set(orgId, result);
        return result;
      },
      async members(orgId) {
        const hit = membersCache.get(orgId);
        if (hit) return hit;
        const result = await queryOrgMembers(db, orgId);
        membersCache.set(orgId, result);
        return result;
      },
      async removedMembers(orgId) {
        const hit = removedMembersCache.get(orgId);
        if (hit) return hit;
        const result = await queryRemovedOrgMembers(db, orgId);
        removedMembersCache.set(orgId, result);
        return result;
      },
    },
  };
}
