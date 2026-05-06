/**
 * Thin adapter around `eventsource-parser` that flattens a dispatched
 * `EventSourceMessage` into the `ParsedEvent`s our state machine consumes.
 *
 * Behaviour delegated to the library:
 *   - Line buffering across chunk boundaries (incl. multi-byte char splits)
 *   - SSE field grammar (`id:`, `retry:`, `data:`, comments, blank-line dispatch)
 *   - Multi-line `data:` joining, named events, `\r` / `\r\n` / `\n` endings
 *
 * Behaviour we still own:
 *   - JSON-parsing the dispatched `data` payload into `{ key: enabled }`
 *   - Dropping malformed payloads silently (never throw)
 */

import { createParser } from "eventsource-parser";

export type ParsedEvent =
  | { kind: "id"; value: string }
  | { kind: "retry"; ms: number }
  | { kind: "snapshot"; flags: Record<string, boolean> };

export interface SseParser {
  feed(chunk: string): ParsedEvent[];
}

export function createSseParser(): SseParser {
  let pending: ParsedEvent[] = [];

  const parser = createParser({
    onEvent(msg) {
      if (msg.id) pending.push({ kind: "id", value: msg.id });
      const snapshot = parseSnapshot(msg.data);
      if (snapshot) pending.push({ kind: "snapshot", flags: snapshot });
    },
    onRetry(ms) {
      pending.push({ kind: "retry", ms });
    },
  });

  return {
    feed(chunk: string): ParsedEvent[] {
      parser.feed(chunk);
      const out = pending;
      pending = [];
      return out;
    },
  };
}

function parseSnapshot(payload: string): Record<string, boolean> | null {
  if (!payload) return null;
  try {
    const parsed = JSON.parse(payload) as {
      flags?: Array<{ key: string; enabled: boolean }>;
    };
    if (!parsed || !Array.isArray(parsed.flags)) return null;
    const out: Record<string, boolean> = {};
    for (const f of parsed.flags) out[f.key] = f.enabled;
    return out;
  } catch {
    return null;
  }
}
