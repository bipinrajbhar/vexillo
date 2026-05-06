import { describe, it, expect, mock } from 'bun:test';
import {
  createInMemoryInterContainerBus,
  createRedisInterContainerBus,
} from './adapters';

describe('createInMemoryInterContainerBus', () => {
  it('delivers a published payload to every subscriber for that env', () => {
    const bus = createInMemoryInterContainerBus();
    const a: string[] = [];
    const b: string[] = [];
    bus.subscribe('env-1', (p) => a.push(p));
    bus.subscribe('env-1', (p) => b.push(p));

    bus.publish('env-1', 'payload');

    expect(a).toEqual(['payload']);
    expect(b).toEqual(['payload']);
  });

  it('does not deliver across env ids', () => {
    const bus = createInMemoryInterContainerBus();
    const env1: string[] = [];
    const env2: string[] = [];
    bus.subscribe('env-1', (p) => env1.push(p));
    bus.subscribe('env-2', (p) => env2.push(p));

    bus.publish('env-1', 'only-env1');

    expect(env1).toEqual(['only-env1']);
    expect(env2).toEqual([]);
  });

  it('stops delivering after unsubscribe', () => {
    const bus = createInMemoryInterContainerBus();
    const received: string[] = [];
    const unsub = bus.subscribe('env-1', (p) => received.push(p));

    unsub();
    bus.publish('env-1', 'payload');

    expect(received).toEqual([]);
  });
});

describe('createRedisInterContainerBus', () => {
  it('publishes on the flags:env:<envId> channel', async () => {
    const publisher = { publish: mock(async () => 1) };
    const subscriber = { subscribe: mock(() => {}), unsubscribe: mock(() => {}) };
    const bus = createRedisInterContainerBus({ publisher, subscriber });

    await bus.publish('env-42', '{"flags":[]}');

    expect(publisher.publish).toHaveBeenCalledWith('flags:env:env-42', '{"flags":[]}');
  });

  it('subscribes on the flags:env:<envId> channel and forwards messages', () => {
    let captured: ((m: string, c: string) => void) | undefined;
    const publisher = { publish: mock(async () => 1) };
    const subscriber = {
      subscribe: mock((_channel: string, listener: (m: string, c: string) => void) => {
        captured = listener;
      }),
      unsubscribe: mock(() => {}),
    };
    const bus = createRedisInterContainerBus({ publisher, subscriber });
    const received: string[] = [];

    bus.subscribe('env-1', (p) => received.push(p));
    captured?.('payload', 'flags:env:env-1');

    expect(subscriber.subscribe).toHaveBeenCalledWith('flags:env:env-1', expect.any(Function));
    expect(received).toEqual(['payload']);
  });

  it('unsubscribes on the same channel when the unsubscribe fn is called', () => {
    const publisher = { publish: mock(async () => 1) };
    const subscriber = { subscribe: mock(() => {}), unsubscribe: mock(() => {}) };
    const bus = createRedisInterContainerBus({ publisher, subscriber });
    const unsub = bus.subscribe('env-1', () => {});

    unsub();

    expect(subscriber.unsubscribe).toHaveBeenCalledWith('flags:env:env-1');
  });
});
