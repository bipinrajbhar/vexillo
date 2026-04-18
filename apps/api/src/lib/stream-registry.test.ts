import { describe, it, expect, mock } from 'bun:test';
import { createStreamRegistry, type RedisSubscriber } from './stream-registry';

// Minimal mock satisfying RedisSubscriber. Exposes `emit` to simulate
// incoming Redis messages without a real Redis connection.
function makeMockSubscriber() {
  type Listener = (message: string, channel: string) => void;
  const listeners = new Map<string, Listener>();

  const subscriber = {
    subscribe: mock((channel: string, listener: Listener) => {
      listeners.set(channel, listener);
    }),
    unsubscribe: mock((channel: string) => {
      listeners.delete(channel);
    }),
    emit(channel: string, message: string) {
      listeners.get(channel)?.(message, channel);
    },
  } satisfies RedisSubscriber & { emit: (ch: string, msg: string) => void };

  return subscriber;
}

describe('createStreamRegistry', () => {
  it('delivers broadcast payload to a registered send function', () => {
    const sub = makeMockSubscriber();
    const registry = createStreamRegistry(sub);
    const received: string[] = [];

    registry.register('env-1', (p) => received.push(p));
    registry.broadcast('env-1', '{"flags":[]}');

    expect(received).toEqual(['{"flags":[]}']);
  });

  it('delivers to all send functions registered for the same environment', () => {
    const sub = makeMockSubscriber();
    const registry = createStreamRegistry(sub);
    const a: string[] = [];
    const b: string[] = [];

    registry.register('env-1', (p) => a.push(p));
    registry.register('env-1', (p) => b.push(p));
    registry.broadcast('env-1', 'payload');

    expect(a).toEqual(['payload']);
    expect(b).toEqual(['payload']);
  });

  it('does not deliver to send functions for a different environment', () => {
    const sub = makeMockSubscriber();
    const registry = createStreamRegistry(sub);
    const env1: string[] = [];
    const env2: string[] = [];

    registry.register('env-1', (p) => env1.push(p));
    registry.register('env-2', (p) => env2.push(p));
    registry.broadcast('env-1', 'only-env1');

    expect(env1).toEqual(['only-env1']);
    expect(env2).toEqual([]);
  });

  it('subscribes to the Redis channel when the first client connects', () => {
    const sub = makeMockSubscriber();
    const registry = createStreamRegistry(sub);

    registry.register('env-1', () => {});

    expect(sub.subscribe).toHaveBeenCalledTimes(1);
    expect(sub.subscribe).toHaveBeenCalledWith('flags:env:env-1', expect.any(Function));
  });

  it('does not subscribe again when a second client connects for the same environment', () => {
    const sub = makeMockSubscriber();
    const registry = createStreamRegistry(sub);

    registry.register('env-1', () => {});
    registry.register('env-1', () => {});

    expect(sub.subscribe).toHaveBeenCalledTimes(1);
  });

  it('unsubscribes from the Redis channel when the last client disconnects', () => {
    const sub = makeMockSubscriber();
    const registry = createStreamRegistry(sub);
    const unregister = registry.register('env-1', () => {});

    expect(sub.unsubscribe).not.toHaveBeenCalled();
    unregister();
    expect(sub.unsubscribe).toHaveBeenCalledWith('flags:env:env-1');
  });

  it('does not unsubscribe while there are still connected clients', () => {
    const sub = makeMockSubscriber();
    const registry = createStreamRegistry(sub);
    const unregister1 = registry.register('env-1', () => {});
    registry.register('env-1', () => {});

    unregister1();

    expect(sub.unsubscribe).not.toHaveBeenCalled();
  });

  it('delivers Redis messages via the subscriber callback to send functions', () => {
    const sub = makeMockSubscriber();
    const registry = createStreamRegistry(sub);
    const received: string[] = [];

    registry.register('env-1', (p) => received.push(p));
    sub.emit('flags:env:env-1', '{"flags":[{"key":"f","enabled":true}]}');

    expect(received).toEqual(['{"flags":[{"key":"f","enabled":true}]}']);
  });
});
