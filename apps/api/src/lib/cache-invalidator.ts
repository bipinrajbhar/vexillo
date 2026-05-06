export interface CacheInvalidatorDeps {
  flagsCache: { delete(key: string): void };
  envsCache: { delete(key: string): void };
  membersCache: { delete(key: string): void };
  removedMembersCache: { delete(key: string): void };
  clearAuthCache?: (environmentId: string) => void;
}

export interface DashboardCacheInvalidator {
  onFlagMutation(orgId: string): void;
  onEnvironmentStructuralChange(orgId: string): void;
  onEnvironmentOriginsUpdate(orgId: string, environmentId: string): void;
  onEnvironmentKeyRotation(orgId: string, environmentId: string): void;
  onMemberMutation(orgId: string): void;
}

export function createCacheInvalidator(deps: CacheInvalidatorDeps): DashboardCacheInvalidator {
  return {
    onFlagMutation(orgId) {
      deps.flagsCache.delete(orgId);
    },
    onEnvironmentStructuralChange(orgId) {
      deps.envsCache.delete(orgId);
      deps.flagsCache.delete(orgId);
    },
    onEnvironmentOriginsUpdate(orgId, environmentId) {
      deps.envsCache.delete(orgId);
      deps.clearAuthCache?.(environmentId);
    },
    onEnvironmentKeyRotation(orgId, environmentId) {
      deps.envsCache.delete(orgId);
      deps.clearAuthCache?.(environmentId);
    },
    onMemberMutation(orgId) {
      deps.membersCache.delete(orgId);
      deps.removedMembersCache.delete(orgId);
    },
  };
}
