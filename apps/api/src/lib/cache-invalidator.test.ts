import { describe, it, expect, mock } from 'bun:test';
import { createCacheInvalidator } from './cache-invalidator';

function makeDeps() {
  return {
    flagsCache: { delete: mock((_key: string) => {}) },
    envsCache: { delete: mock((_key: string) => {}) },
    membersCache: { delete: mock((_key: string) => {}) },
    removedMembersCache: { delete: mock((_key: string) => {}) },
    clearAuthCache: mock((_envId: string) => {}),
  };
}

describe('createCacheInvalidator — onFlagMutation', () => {
  it('clears only the flags cache', () => {
    const deps = makeDeps();
    const cache = createCacheInvalidator(deps);
    cache.onFlagMutation('org-1');

    expect(deps.flagsCache.delete).toHaveBeenCalledTimes(1);
    expect(deps.flagsCache.delete.mock.calls[0]).toEqual(['org-1']);
    expect(deps.envsCache.delete).not.toHaveBeenCalled();
    expect(deps.membersCache.delete).not.toHaveBeenCalled();
    expect(deps.removedMembersCache.delete).not.toHaveBeenCalled();
    expect(deps.clearAuthCache).not.toHaveBeenCalled();
  });
});

describe('createCacheInvalidator — onEnvironmentStructuralChange', () => {
  it('clears both envs and flags caches', () => {
    const deps = makeDeps();
    const cache = createCacheInvalidator(deps);
    cache.onEnvironmentStructuralChange('org-1');

    expect(deps.envsCache.delete).toHaveBeenCalledTimes(1);
    expect(deps.envsCache.delete.mock.calls[0]).toEqual(['org-1']);
    expect(deps.flagsCache.delete).toHaveBeenCalledTimes(1);
    expect(deps.flagsCache.delete.mock.calls[0]).toEqual(['org-1']);
    expect(deps.membersCache.delete).not.toHaveBeenCalled();
    expect(deps.removedMembersCache.delete).not.toHaveBeenCalled();
    expect(deps.clearAuthCache).not.toHaveBeenCalled();
  });
});

describe('createCacheInvalidator — onEnvironmentOriginsUpdate', () => {
  it('clears envs cache and calls clearAuthCache with environmentId — NOT flags cache', () => {
    const deps = makeDeps();
    const cache = createCacheInvalidator(deps);
    cache.onEnvironmentOriginsUpdate('org-1', 'env-42');

    expect(deps.envsCache.delete).toHaveBeenCalledTimes(1);
    expect(deps.envsCache.delete.mock.calls[0]).toEqual(['org-1']);
    expect(deps.clearAuthCache).toHaveBeenCalledTimes(1);
    expect(deps.clearAuthCache.mock.calls[0]).toEqual(['env-42']);
    expect(deps.flagsCache.delete).not.toHaveBeenCalled();
    expect(deps.membersCache.delete).not.toHaveBeenCalled();
    expect(deps.removedMembersCache.delete).not.toHaveBeenCalled();
  });

  it('does not throw when clearAuthCache is not provided', () => {
    const { clearAuthCache: _, ...depsWithoutAuth } = makeDeps();
    const cache = createCacheInvalidator(depsWithoutAuth);
    expect(() => cache.onEnvironmentOriginsUpdate('org-1', 'env-42')).not.toThrow();
    expect(depsWithoutAuth.envsCache.delete).toHaveBeenCalledTimes(1);
  });
});

describe('createCacheInvalidator — onEnvironmentKeyRotation', () => {
  it('clears envs cache and calls clearAuthCache with environmentId — NOT flags cache', () => {
    const deps = makeDeps();
    const cache = createCacheInvalidator(deps);
    cache.onEnvironmentKeyRotation('org-1', 'env-99');

    expect(deps.envsCache.delete).toHaveBeenCalledTimes(1);
    expect(deps.envsCache.delete.mock.calls[0]).toEqual(['org-1']);
    expect(deps.clearAuthCache).toHaveBeenCalledTimes(1);
    expect(deps.clearAuthCache.mock.calls[0]).toEqual(['env-99']);
    expect(deps.flagsCache.delete).not.toHaveBeenCalled();
    expect(deps.membersCache.delete).not.toHaveBeenCalled();
    expect(deps.removedMembersCache.delete).not.toHaveBeenCalled();
  });

  it('does not throw when clearAuthCache is not provided', () => {
    const { clearAuthCache: _, ...depsWithoutAuth } = makeDeps();
    const cache = createCacheInvalidator(depsWithoutAuth);
    expect(() => cache.onEnvironmentKeyRotation('org-1', 'env-99')).not.toThrow();
    expect(depsWithoutAuth.envsCache.delete).toHaveBeenCalledTimes(1);
  });
});

describe('createCacheInvalidator — onMemberMutation', () => {
  it('clears both members and removedMembers caches', () => {
    const deps = makeDeps();
    const cache = createCacheInvalidator(deps);
    cache.onMemberMutation('org-1');

    expect(deps.membersCache.delete).toHaveBeenCalledTimes(1);
    expect(deps.membersCache.delete.mock.calls[0]).toEqual(['org-1']);
    expect(deps.removedMembersCache.delete).toHaveBeenCalledTimes(1);
    expect(deps.removedMembersCache.delete.mock.calls[0]).toEqual(['org-1']);
    expect(deps.flagsCache.delete).not.toHaveBeenCalled();
    expect(deps.envsCache.delete).not.toHaveBeenCalled();
    expect(deps.clearAuthCache).not.toHaveBeenCalled();
  });
});
