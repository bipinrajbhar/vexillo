import type { NotifyFlagChange } from '../services/dashboard-service';

export interface NotifyCall {
  environmentId: string;
  payload: string;
  parsedPayload: unknown;
}

export interface TestFlagChangeNotifier {
  notify: NotifyFlagChange;
  calls: NotifyCall[];
  lastCall: () => NotifyCall | undefined;
  callsFor: (environmentId: string) => NotifyCall[];
  reset: () => void;
}

export function createTestFlagChangeNotifier(): TestFlagChangeNotifier {
  const calls: NotifyCall[] = [];

  const notify: NotifyFlagChange = (environmentId: string, payload: string) => {
    let parsedPayload: unknown;
    try {
      parsedPayload = JSON.parse(payload);
    } catch {
      parsedPayload = payload;
    }
    calls.push({ environmentId, payload, parsedPayload });
  };

  return {
    notify,
    calls,
    lastCall: () => calls[calls.length - 1],
    callsFor: (environmentId: string) => calls.filter((c) => c.environmentId === environmentId),
    reset: () => { calls.length = 0; },
  };
}
