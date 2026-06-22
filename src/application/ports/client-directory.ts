import type { RobloxClient } from "../../domain/client/client.js";
import type { ClientId } from "../../domain/shared/ids.js";

/**
 * Read model of the currently-connected clients, published by the transport.
 * Application services query it; they never mutate the live socket set.
 */
export interface ClientDirectory {
  list(): readonly RobloxClient[];
  get(clientId: ClientId): RobloxClient | undefined;
}
