import { z } from "zod";

import { ProtocolError } from "../../domain/errors/errors.js";
import type {
  ClientHandshake,
  ClientMessage,
  ClientOp,
  OpResult,
  PubSubFrame,
  RpcBatchCall,
  RpcBatchResultEntry,
  RpcResult,
  ServerMessage,
} from "../../domain/protocol/messages.js";

/**
 * The single source of truth for wire validation. These zod schemas mirror the
 * pure shapes in `domain/protocol/messages.ts`; the domain stays dependency-free
 * while this adapter owns runtime parsing. Anything that does not match exactly
 * is rejected as a {@link ProtocolError}, so malformed or hostile input never
 * reaches the application layer.
 */

const handshakeSchema = z.object({
  clientId: z.string(),
  userId: z.number().nullable(),
  username: z.string().nullable(),
  displayName: z.string().nullable(),
  gameName: z.string().nullable().optional(),
  placeId: z.number().nullable(),
  jobId: z.string().nullable(),
  executor: z.string().nullable(),
  capabilities: z.array(z.string()).readonly(),
  token: z.string().nullable().optional(),
}) satisfies z.ZodType<ClientHandshake>;

const opResultSchema = z.union([
  z.object({ ok: z.literal(true), value: z.unknown() }),
  z.object({
    ok: z.literal(false),
    error: z.string(),
    kind: z.enum(["timeout", "runtime", "overloaded"]).optional(),
  }),
]) satisfies z.ZodType<OpResult>;

const clientOpSchema = z.object({
  kind: z.literal("eval"),
  source: z.string(),
  threadContext: z.number(),
  timeoutMs: z.number(),
  env: z.enum(["fresh", "vm", "vm-reset"]).optional(),
  scriptToken: z.string().optional(),
  priority: z.enum(["normal", "nested"]).optional(),
  vmScope: z.string().max(256).optional(),
}) satisfies z.ZodType<ClientOp>;

const rpcResultSchema = z.union([
  z.object({ ok: z.literal(true), data: z.unknown() }),
  z.object({ ok: z.literal(false), error: z.string(), code: z.string().optional() }),
]) satisfies z.ZodType<RpcResult>;

const rpcBatchCallSchema = z.object({
  key: z.string(),
  tool: z.string(),
  args: z.unknown(),
}) satisfies z.ZodType<RpcBatchCall>;

const pubSubFrameSchema = z.object({
  channel: z.string(),
  payload: z.unknown(),
  fromClientId: z.string().optional(),
}) satisfies z.ZodType<PubSubFrame>;

const rpcBatchResultEntrySchema = z.union([
  z.object({ key: z.string(), ok: z.literal(true), data: z.unknown() }),
  z.object({
    key: z.string(),
    ok: z.literal(false),
    error: z.string(),
    code: z.string().optional(),
  }),
]) satisfies z.ZodType<RpcBatchResultEntry>;

const serverMessageSchema = z.union([
  z.object({
    type: z.literal("welcome"),
    serverVersion: z.string(),
    heartbeatIntervalMs: z.number(),
  }),
  z.object({ type: z.literal("op"), id: z.string(), op: clientOpSchema }),
  z.object({ type: z.literal("ping"), id: z.string() }),
  z.object({ type: z.literal("rpc-result"), id: z.string(), result: rpcResultSchema }),
  z.object({
    type: z.literal("rpc-batch-result"),
    id: z.string(),
    results: z.array(rpcBatchResultEntrySchema).readonly(),
  }),
  z.object({ type: z.literal("pubsub-message"), frame: pubSubFrameSchema }),
]) satisfies z.ZodType<ServerMessage>;

const clientMessageSchema = z.union([
  z.object({
    type: z.literal("hello"),
    protocolVersion: z.number(),
    client: handshakeSchema,
  }),
  z.object({ type: z.literal("result"), id: z.string(), result: opResultSchema }),
  z.object({ type: z.literal("event"), channel: z.string(), data: z.unknown() }),
  z.object({ type: z.literal("pong"), id: z.string() }),
  z.object({
    type: z.literal("rpc-call"),
    id: z.string(),
    token: z.string(),
    tool: z.string(),
    args: z.unknown(),
  }),
  z.object({
    type: z.literal("rpc-batch"),
    id: z.string(),
    token: z.string(),
    // Hard cap so a hostile frame can't force an O(N) allocation + multi-MB reply.
    // Reasonable overages above the per-batch safety cap are still handled
    // gracefully in handleRpcBatch; only clearly-abusive frames are rejected here.
    calls: z.array(rpcBatchCallSchema).max(4096).readonly(),
  }),
  z.object({ type: z.literal("pubsub-subscribe"), channel: z.string().max(256) }),
  z.object({ type: z.literal("pubsub-unsubscribe"), channel: z.string().max(256) }),
  z.object({ type: z.literal("pubsub-publish"), channel: z.string(), payload: z.unknown() }),
]) satisfies z.ZodType<ClientMessage>;

/**
 * Parse a raw socket frame into a typed {@link ClientMessage}. Throws a
 * {@link ProtocolError} on invalid JSON, a non-object root, an unknown `type`,
 * or any field that fails the schema.
 */
export function decodeClientMessage(raw: string): ClientMessage {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new ProtocolError(
      "Bridge message was not valid JSON.",
      { sample: raw.slice(0, 256) },
      { cause },
    );
  }

  const result = clientMessageSchema.safeParse(parsed);
  if (!result.success) {
    throw new ProtocolError("Bridge message failed protocol validation.", {
      issues: result.error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      })),
    });
  }
  return result.data;
}

/** Serialize a {@link ServerMessage} for the wire. */
export function encodeServerMessage(msg: ServerMessage): string {
  const result = serverMessageSchema.safeParse(msg);
  if (!result.success) {
    throw new ProtocolError("Refused to encode an invalid server message.", {
      issues: result.error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      })),
    });
  }
  return JSON.stringify(result.data);
}
