import type { ClientId } from "../../domain/shared/ids.js";

/**
 * Administrative actions on connected clients. Separate from {@link ClientDirectory}
 * (which is read-only) because closing a session is a side-effectful operation that
 * not every consumer of the directory should be able to perform.
 */
export interface ClientAdmin {
  /** Close one client's bridge socket. Returns `true` if it was connected. */
  disconnect(clientId: ClientId, reason?: string): boolean;
}
