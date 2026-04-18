// Narrow interface satisfied by Bun's RedisClient (subscribe mode).
export interface RedisSubscriber {
  subscribe(
    channel: string,
    listener: (message: string, channel: string) => void,
  ): Promise<number> | void;
  unsubscribe(channel: string): Promise<void> | void;
}

export type SendFn = (payload: string) => void;

export interface StreamRegistry {
  /**
   * Register a send function for an environment. Subscribes to the Redis
   * channel when the first client connects for that environment. Returns an
   * unregister function that unsubscribes when the last client disconnects.
   */
  register(environmentId: string, send: SendFn): () => void;
  /**
   * Deliver a payload directly to all send functions registered for an
   * environment (bypasses Redis). Used internally by the Redis subscriber
   * callback and exposed for testing / single-process publishing.
   */
  broadcast(environmentId: string, payload: string): void;
}

export function createStreamRegistry(subscriber?: RedisSubscriber): StreamRegistry {
  const envSends = new Map<string, Set<SendFn>>();

  function broadcast(envId: string, payload: string): void {
    const sends = envSends.get(envId);
    if (!sends) return;
    for (const send of sends) send(payload);
  }

  function register(envId: string, send: SendFn): () => void {
    let set = envSends.get(envId);
    if (!set) {
      set = new Set();
      envSends.set(envId, set);
      subscriber?.subscribe(`flags:env:${envId}`, (message) => broadcast(envId, message));
    }
    set.add(send);

    return () => {
      set!.delete(send);
      if (set!.size === 0) {
        envSends.delete(envId);
        subscriber?.unsubscribe(`flags:env:${envId}`);
      }
    };
  }

  return { register, broadcast };
}
