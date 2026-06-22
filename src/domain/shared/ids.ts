import type { Brand } from "./brand.js";

/** A connected executor connection. New value every (re)connect / server rejoin. */
export type ClientId = Brand<string, "ClientId">;
/** One AI conversation/session driving the bridge. */
export type SessionId = Brand<string, "SessionId">;
/** A Roblox account id — stable across reconnects, used for sticky selection. */
export type UserId = Brand<number, "UserId">;
/** Correlates a bridge request with its response. */
export type RequestId = Brand<string, "RequestId">;

export const ClientId = (value: string): ClientId => value as ClientId;
export const SessionId = (value: string): SessionId => value as SessionId;
export const UserId = (value: number): UserId => value as UserId;
export const RequestId = (value: string): RequestId => value as RequestId;
