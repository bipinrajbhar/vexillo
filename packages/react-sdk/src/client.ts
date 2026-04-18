import { fetchFlags } from "./fetch-flags";

export interface VexilloClientConfig {
  baseUrl: string;
  apiKey: string;
  /** Pre-resolved flags. When provided, isReady is true immediately. */
  initialFlags?: Record<string, boolean>;
  /** Returned for unknown keys when no remote value exists. */
  fallbacks?: Record<string, boolean>;
  /** Called on every load() error. */
  onError?: (err: Error) => void;
}

export interface VexilloClient {
  /** Fetches flags from the server and notifies subscribers. */
  load(): Promise<void>;
  /** Synchronous read. Priority: overrides > remote > fallbacks > false. */
  getFlag(key: string): boolean;
  /** Snapshot of all resolved flags (overrides + remote + fallbacks merged). */
  getAllFlags(): Record<string, boolean>;
  /**
   * Subscribe to changes on a specific key. Fires on load(), override(), and
   * clearOverride(). Returns an unsubscribe function.
   */
  subscribe(key: string, listener: (value: boolean) => void): () => void;
  /**
   * Subscribe to any flag change. Returns an unsubscribe function.
   */
  subscribeAll(listener: (flags: Record<string, boolean>) => void): () => void;
  /** Imperatively set flag values. Notifies subscribers immediately. */
  override(overrides: Record<string, boolean>): void;
  /** Remove an override for a specific key and notify subscribers. */
  clearOverride(key: string): void;
  /** Remove all overrides and notify subscribers. */
  clearOverrides(): void;
  readonly isReady: boolean;
  readonly lastError: Error | null;
}

export function createVexilloClient(config: VexilloClientConfig): VexilloClient {
  const { baseUrl, apiKey, fallbacks = {}, onError } = config;

  let remoteFlags: Record<string, boolean> = config.initialFlags ?? {};
  let overrides: Record<string, boolean> = {};
  let ready = config.initialFlags !== undefined;
  let error: Error | null = null;

  const keyListeners = new Map<string, Set<(value: boolean) => void>>();
  const allListeners = new Set<(flags: Record<string, boolean>) => void>();

  function resolve(key: string): boolean {
    if (key in overrides) return overrides[key];
    if (key in remoteFlags) return remoteFlags[key];
    if (key in fallbacks) return fallbacks[key];
    return false;
  }

  function snapshot(): Record<string, boolean> {
    const out: Record<string, boolean> = {};
    for (const [k, v] of Object.entries(fallbacks)) out[k] = v;
    for (const [k, v] of Object.entries(remoteFlags)) out[k] = v;
    for (const [k, v] of Object.entries(overrides)) out[k] = v;
    return out;
  }

  function notifyKey(key: string): void {
    const listeners = keyListeners.get(key);
    if (!listeners) return;
    for (const l of listeners) l(resolve(key));
  }

  function notifyAll(): void {
    const snap = snapshot();
    for (const l of allListeners) l(snap);
    for (const key of keyListeners.keys()) notifyKey(key);
  }

  async function load(): Promise<void> {
    try {
      remoteFlags = await fetchFlags(baseUrl, apiKey);
      error = null;
    } catch (err) {
      error = err instanceof Error ? err : new Error(String(err));
      onError?.(error);
    }
    ready = true;
    notifyAll();
  }

  function getFlag(key: string): boolean {
    return resolve(key);
  }

  function getAllFlags(): Record<string, boolean> {
    return snapshot();
  }

  function subscribe(key: string, listener: (value: boolean) => void): () => void {
    let set = keyListeners.get(key);
    if (!set) {
      set = new Set();
      keyListeners.set(key, set);
    }
    set.add(listener);
    return () => {
      set!.delete(listener);
      if (set!.size === 0) keyListeners.delete(key);
    };
  }

  function subscribeAll(listener: (flags: Record<string, boolean>) => void): () => void {
    allListeners.add(listener);
    return () => allListeners.delete(listener);
  }

  function override(newOverrides: Record<string, boolean>): void {
    const affected = Object.keys(newOverrides);
    for (const key of affected) overrides[key] = newOverrides[key];
    const snap = snapshot();
    for (const l of allListeners) l(snap);
    for (const key of affected) notifyKey(key);
  }

  function clearOverride(key: string): void {
    if (!(key in overrides)) return;
    delete overrides[key];
    const snap = snapshot();
    for (const l of allListeners) l(snap);
    notifyKey(key);
  }

  function clearOverrides(): void {
    const affected = Object.keys(overrides);
    if (affected.length === 0) return;
    overrides = {};
    const snap = snapshot();
    for (const l of allListeners) l(snap);
    for (const key of affected) notifyKey(key);
  }

  return {
    load,
    getFlag,
    getAllFlags,
    subscribe,
    subscribeAll,
    override,
    clearOverride,
    clearOverrides,
    get isReady() { return ready; },
    get lastError() { return error; },
  };
}
