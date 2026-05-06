/**
 * Pure SSE byte/line parser. Buffers partial lines across chunks and emits
 * one event per recognised field. Never throws.
 *
 * Recognised fields (each must end with `\n`):
 *   `id: <value>`          — sets lastEventId; emits `{ kind: 'id' }`
 *   `retry: <ms>`          — emits `{ kind: 'retry', ms }` (parsed integer)
 *   `data: <json>`         — emits `{ kind: 'snapshot', flags }` if the JSON
 *                            shape is `{ flags: Array<{ key, enabled }> }`;
 *                            silently dropped on parse failure
 *
 * Comments (`:keepalive`), blank lines, and unknown fields are skipped.
 */

export interface ParserState {
  buf: string;
  lastEventId: string | null;
}

export type ParsedEvent =
  | { kind: "id"; value: string }
  | { kind: "retry"; ms: number }
  | { kind: "snapshot"; flags: Record<string, boolean> };

export function makeInitialParserState(
  lastEventId: string | null = null,
): ParserState {
  return { buf: "", lastEventId };
}

export function feedSse(
  state: ParserState,
  chunk: string,
): { state: ParserState; events: ParsedEvent[] } {
  const combined = state.buf + chunk;
  const lines = combined.split("\n");
  const remaining = lines.pop() ?? "";
  const events: ParsedEvent[] = [];
  let lastEventId = state.lastEventId;

  for (const rawLine of lines) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;

    if (line.startsWith("id: ")) {
      const value = line.slice(4).trim();
      lastEventId = value;
      events.push({ kind: "id", value });
    } else if (line.startsWith("retry: ")) {
      const ms = parseInt(line.slice(7), 10);
      if (!isNaN(ms)) events.push({ kind: "retry", ms });
    } else if (line.startsWith("data: ")) {
      const snapshot = parseSnapshot(line.slice(6));
      if (snapshot) events.push({ kind: "snapshot", flags: snapshot });
    }
    // comments (lines starting with ':'), blank lines, unknown fields: ignore
  }

  return { state: { buf: remaining, lastEventId }, events };
}

function parseSnapshot(payload: string): Record<string, boolean> | null {
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
