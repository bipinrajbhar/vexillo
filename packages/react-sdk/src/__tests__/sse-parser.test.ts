import { describe, it, expect } from "vitest";
import {
  feedSse,
  makeInitialParserState,
  type ParsedEvent,
} from "../sse-parser";

function feedAll(chunks: string[]): {
  events: ParsedEvent[];
  lastEventId: string | null;
  buf: string;
} {
  let state = makeInitialParserState();
  const events: ParsedEvent[] = [];
  for (const c of chunks) {
    const r = feedSse(state, c);
    state = r.state;
    events.push(...r.events);
  }
  return { events, lastEventId: state.lastEventId, buf: state.buf };
}

describe("feedSse", () => {
  it("emits a snapshot for a complete data: line", () => {
    const { events } = feedAll([
      'data: {"flags":[{"key":"a","enabled":true}]}\n',
    ]);
    expect(events).toEqual([{ kind: "snapshot", flags: { a: true } }]);
  });

  it("reassembles a data: line split across two chunks", () => {
    const { events } = feedAll([
      'data: {"flags":[{"key":"a"',
      ',"enabled":true}]}\n',
    ]);
    expect(events).toEqual([{ kind: "snapshot", flags: { a: true } }]);
  });

  it("buffers a chunk with no trailing newline and emits later", () => {
    let state = makeInitialParserState();
    const r1 = feedSse(state, 'data: {"flags":[{"key":"a","enabled":true}]}');
    state = r1.state;
    expect(r1.events).toEqual([]);
    expect(state.buf.length).toBeGreaterThan(0);

    const r2 = feedSse(state, "\n");
    expect(r2.events).toEqual([{ kind: "snapshot", flags: { a: true } }]);
  });

  it("records id: and emits an id event without a snapshot", () => {
    const { events, lastEventId } = feedAll(["id: 42\n"]);
    expect(events).toEqual([{ kind: "id", value: "42" }]);
    expect(lastEventId).toBe("42");
  });

  it("records retry: and emits a retry event", () => {
    const { events } = feedAll(["retry: 2500\n"]);
    expect(events).toEqual([{ kind: "retry", ms: 2500 }]);
  });

  it("ignores retry: with a non-integer payload", () => {
    const { events } = feedAll(["retry: nope\n"]);
    expect(events).toEqual([]);
  });

  it("drops malformed JSON in data: lines without throwing", () => {
    const { events } = feedAll(["data: {not json\n"]);
    expect(events).toEqual([]);
  });

  it("drops data: payloads missing the flags array", () => {
    const { events } = feedAll(['data: {"foo":1}\n']);
    expect(events).toEqual([]);
  });

  it("ignores comment lines (`: keepalive`)", () => {
    const { events } = feedAll([": keepalive\n"]);
    expect(events).toEqual([]);
  });

  it("processes id: then data: across separate chunks in order", () => {
    const { events, lastEventId } = feedAll([
      "id: 7\n",
      'data: {"flags":[{"key":"x","enabled":false}]}\n',
    ]);
    expect(events).toEqual([
      { kind: "id", value: "7" },
      { kind: "snapshot", flags: { x: false } },
    ]);
    expect(lastEventId).toBe("7");
  });

  it("handles a full SSE event terminated by a blank line", () => {
    const { events, lastEventId } = feedAll([
      "retry: 500\nid: 1\ndata: {\"flags\":[{\"key\":\"a\",\"enabled\":true}]}\n\n",
    ]);
    expect(events).toEqual([
      { kind: "retry", ms: 500 },
      { kind: "id", value: "1" },
      { kind: "snapshot", flags: { a: true } },
    ]);
    expect(lastEventId).toBe("1");
  });

  it("trims a trailing \\r from CRLF-terminated lines", () => {
    const { events, lastEventId } = feedAll(["id: 99\r\n"]);
    expect(events).toEqual([{ kind: "id", value: "99" }]);
    expect(lastEventId).toBe("99");
  });
});
