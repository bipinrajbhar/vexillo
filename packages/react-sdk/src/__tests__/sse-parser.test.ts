import { describe, it, expect } from "vitest";
import { createSseParser, type ParsedEvent } from "../sse-parser";

function feedAll(chunks: string[]): ParsedEvent[] {
  const parser = createSseParser();
  const events: ParsedEvent[] = [];
  for (const c of chunks) events.push(...parser.feed(c));
  return events;
}

describe("createSseParser", () => {
  it("emits a snapshot once the event terminates with a blank line", () => {
    const events = feedAll([
      'data: {"flags":[{"key":"a","enabled":true}]}\n\n',
    ]);
    expect(events).toEqual([{ kind: "snapshot", flags: { a: true } }]);
  });

  it("does not emit before the terminating blank line", () => {
    const parser = createSseParser();
    const partial = parser.feed(
      'data: {"flags":[{"key":"a","enabled":true}]}\n',
    );
    expect(partial).toEqual([]);
    const finished = parser.feed("\n");
    expect(finished).toEqual([{ kind: "snapshot", flags: { a: true } }]);
  });

  it("reassembles a data: line split across chunks", () => {
    const events = feedAll([
      'data: {"flags":[{"key":"a"',
      ',"enabled":true}]}\n\n',
    ]);
    expect(events).toEqual([{ kind: "snapshot", flags: { a: true } }]);
  });

  it("emits id then snapshot in order for an id+data event", () => {
    const events = feedAll([
      'id: 7\ndata: {"flags":[{"key":"x","enabled":false}]}\n\n',
    ]);
    expect(events).toEqual([
      { kind: "id", value: "7" },
      { kind: "snapshot", flags: { x: false } },
    ]);
  });

  it("emits retry as soon as the line is parsed (no blank line needed)", () => {
    const events = feedAll(["retry: 2500\n"]);
    expect(events).toEqual([{ kind: "retry", ms: 2500 }]);
  });

  it("ignores retry: with a non-integer payload", () => {
    const events = feedAll(["retry: nope\n"]);
    expect(events).toEqual([]);
  });

  it("drops malformed JSON in data: payloads without throwing", () => {
    const events = feedAll(["data: {not json\n\n"]);
    expect(events).toEqual([]);
  });

  it("drops data: payloads missing the flags array", () => {
    const events = feedAll(['data: {"foo":1}\n\n']);
    expect(events).toEqual([]);
  });

  it("ignores comment lines (`: keepalive`)", () => {
    const events = feedAll([": keepalive\n\n"]);
    expect(events).toEqual([]);
  });

  it("emits all three field kinds in a single event terminated by a blank line", () => {
    const events = feedAll([
      'retry: 500\nid: 1\ndata: {"flags":[{"key":"a","enabled":true}]}\n\n',
    ]);
    expect(events).toEqual([
      { kind: "retry", ms: 500 },
      { kind: "id", value: "1" },
      { kind: "snapshot", flags: { a: true } },
    ]);
  });

  it("handles CRLF line endings", () => {
    const events = feedAll([
      'id: 99\r\ndata: {"flags":[{"key":"a","enabled":true}]}\r\n\r\n',
    ]);
    expect(events).toEqual([
      { kind: "id", value: "99" },
      { kind: "snapshot", flags: { a: true } },
    ]);
  });

  it("flushes the pending buffer between feed() calls", () => {
    const parser = createSseParser();
    parser.feed("retry: 100\n");
    const second = parser.feed(
      'data: {"flags":[{"key":"a","enabled":true}]}\n\n',
    );
    // The retry was returned by the first feed(); the second only emits the snapshot.
    expect(second).toEqual([{ kind: "snapshot", flags: { a: true } }]);
  });
});
