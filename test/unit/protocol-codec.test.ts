import { describe, expect, it } from "vitest";
import {
  decodeClientMessage,
  encodeServerMessage,
} from "../../src/infrastructure/transport/protocol-codec.js";
import { ProtocolError } from "../../src/domain/errors/errors.js";
import type { ClientMessage, ServerMessage } from "../../src/domain/protocol/messages.js";
import { PROTOCOL_VERSION } from "../../src/domain/protocol/messages.js";

describe("decodeClientMessage", () => {
  it("round-trips a valid hello", () => {
    const hello: ClientMessage = {
      type: "hello",
      protocolVersion: PROTOCOL_VERSION,
      client: {
        clientId: "conn-1",
        userId: 42,
        username: "neo",
        displayName: "Neo",
        placeId: 123,
        jobId: "job-1",
        executor: "TestExecutor",
        capabilities: ["getgc", "hookfunction"],
      },
    };
    const decoded = decodeClientMessage(JSON.stringify(hello));
    expect(decoded).toEqual(hello);
  });

  it("round-trips a valid result (ok)", () => {
    const result: ClientMessage = {
      type: "result",
      id: "req-1",
      result: { ok: true, value: { hp: 100 } },
    };
    const decoded = decodeClientMessage(JSON.stringify(result));
    expect(decoded).toEqual(result);
  });

  it("round-trips a valid result (error)", () => {
    const result: ClientMessage = {
      type: "result",
      id: "req-2",
      result: { ok: false, error: "boom", kind: "runtime" },
    };
    const decoded = decodeClientMessage(JSON.stringify(result));
    expect(decoded).toEqual(result);
  });

  it("round-trips a valid pong", () => {
    const pong: ClientMessage = { type: "pong", id: "ping-1" };
    const decoded = decodeClientMessage(JSON.stringify(pong));
    expect(decoded).toEqual(pong);
  });

  it("throws ProtocolError on malformed JSON", () => {
    expect(() => decodeClientMessage("{not json")).toThrow(ProtocolError);
  });

  it("throws ProtocolError on an unknown message type", () => {
    expect(() => decodeClientMessage(JSON.stringify({ type: "wat", id: "x" }))).toThrow(
      ProtocolError,
    );
  });

  it("throws ProtocolError when a required field is missing", () => {
    // hello with no client field.
    expect(() =>
      decodeClientMessage(JSON.stringify({ type: "hello", protocolVersion: PROTOCOL_VERSION })),
    ).toThrow(ProtocolError);
    // result with no id.
    expect(() =>
      decodeClientMessage(JSON.stringify({ type: "result", result: { ok: true, value: 1 } })),
    ).toThrow(ProtocolError);
  });
});

describe("encodeServerMessage", () => {
  it("encodes an op message to valid JSON", () => {
    const op: ServerMessage = {
      type: "op",
      id: "req-1",
      op: { kind: "eval", source: "return 1", threadContext: 8, timeoutMs: 5000 },
    };
    const json = encodeServerMessage(op);
    expect(JSON.parse(json)).toEqual(op);
  });

  it("encodes a welcome message to valid JSON", () => {
    const welcome: ServerMessage = {
      type: "welcome",
      serverVersion: "2.0.0",
      heartbeatIntervalMs: 15000,
    };
    const json = encodeServerMessage(welcome);
    expect(JSON.parse(json)).toEqual(welcome);
  });

  it("encodes a ping message to valid JSON", () => {
    const ping: ServerMessage = { type: "ping", id: "ping-1" };
    const json = encodeServerMessage(ping);
    expect(JSON.parse(json)).toEqual(ping);
  });
});
