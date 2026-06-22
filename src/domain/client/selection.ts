import type { ClientId, UserId } from "../shared/ids.js";
import { isSameAccount, type RobloxClient } from "./client.js";

/**
 * What a session has chosen to target. All fields optional: a session may pin an
 * exact connection (`clientId`), an account (`userId`/`username`, sticky across
 * reconnects), or nothing at all (let the resolver decide when unambiguous).
 */
export interface ClientSelection {
  readonly clientId?: ClientId;
  readonly userId?: UserId;
  readonly username?: string;
}

export type SelectionResolution =
  | { readonly status: "resolved"; readonly client: RobloxClient }
  /** Nothing connected, or the pinned account/connection is gone. */
  | { readonly status: "none"; readonly reason: "no-clients" | "selection-offline" }
  /** Multiple distinct accounts connected and the session has not chosen one. */
  | { readonly status: "ambiguous"; readonly candidates: readonly RobloxClient[] };

const matchesAccount = (client: RobloxClient, selection: ClientSelection): boolean => {
  if (selection.userId !== undefined && client.userId !== null) {
    return client.userId === selection.userId;
  }
  if (selection.username !== undefined && client.username !== null) {
    return client.username.toLowerCase() === selection.username.toLowerCase();
  }
  return false;
};

/**
 * Pure resolution of a session's selection against the live client set. This is
 * the heart of multi-session isolation, kept side-effect-free so it is trivially
 * testable.
 *
 * Order of preference:
 *   1. Exact `clientId`, if still connected.
 *   2. Account match (`userId`/`username`) — sticky across reconnects (new clientId).
 *   3. No selection + exactly one connected account -> that client (convenience).
 *   4. No selection + multiple distinct accounts -> ambiguous.
 *   5. Nothing connected -> none.
 */
export function resolveSelection(
  selection: ClientSelection,
  clients: readonly RobloxClient[],
): SelectionResolution {
  if (clients.length === 0) return { status: "none", reason: "no-clients" };

  const hasPin =
    selection.clientId !== undefined ||
    selection.userId !== undefined ||
    selection.username !== undefined;

  if (selection.clientId !== undefined) {
    const exact = clients.find((c) => c.id === selection.clientId);
    if (exact) return { status: "resolved", client: exact };
    // Fall through: the pinned connection may have reconnected under a new id but
    // the same account, which the account match below recovers.
  }

  if (selection.userId !== undefined || selection.username !== undefined) {
    const byAccount = clients.filter((c) => matchesAccount(c, selection));
    if (byAccount.length >= 1) {
      // Most recently connected wins if the same account has multiple live sockets.
      const newest = byAccount.reduce((a, b) => (b.connectedAt > a.connectedAt ? b : a));
      return { status: "resolved", client: newest };
    }
  }

  if (hasPin) return { status: "none", reason: "selection-offline" };

  // No selection: auto-resolve only when every connection is the same account.
  const distinctAccounts = clients.reduce<RobloxClient[]>((acc, client) => {
    if (!acc.some((seen) => isSameAccount(seen, client))) acc.push(client);
    return acc;
  }, []);

  if (distinctAccounts.length === 1) {
    const newest = clients.reduce((a, b) => (b.connectedAt > a.connectedAt ? b : a));
    return { status: "resolved", client: newest };
  }

  return { status: "ambiguous", candidates: distinctAccounts };
}
