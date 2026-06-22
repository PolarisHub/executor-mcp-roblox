import type { ClientId, UserId } from "../shared/ids.js";

/**
 * A connected executor client, as the domain sees it. This is an immutable view;
 * the transport owns the live socket and republishes a fresh `RobloxClient` on
 * every change. A client's {@link ClientId} is ephemeral (new on each reconnect),
 * while its {@link UserId} is stable and is what sticky selection keys on.
 */
export interface RobloxClient {
  readonly id: ClientId;
  readonly userId: UserId | null;
  readonly username: string | null;
  readonly displayName: string | null;
  readonly placeId: number | null;
  readonly jobId: string | null;
  readonly executor: string | null;
  readonly capabilities: readonly string[];
  /** Epoch millis when the connection was established. */
  readonly connectedAt: number;
}

/** True when both clients are the same Roblox account (stable identity). */
export function isSameAccount(a: RobloxClient, b: RobloxClient): boolean {
  if (a.userId !== null && b.userId !== null) return a.userId === b.userId;
  if (a.username !== null && b.username !== null) {
    return a.username.toLowerCase() === b.username.toLowerCase();
  }
  return a.id === b.id;
}
