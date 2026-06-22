import type { RobloxClient } from "../../domain/client/client.js";
import type { SelectionResolution } from "../../domain/client/selection.js";

/** The stable, AI-facing shape of a connected client. One place defines it. */
export interface ClientView {
  readonly clientId: string;
  readonly username: string | null;
  readonly displayName: string | null;
  readonly userId: number | null;
  readonly placeId: number | null;
  readonly executor: string | null;
  readonly connectedAt: string;
}

/** Project a domain {@link RobloxClient} to the AI-facing {@link ClientView}. */
export function toClientView(client: RobloxClient): ClientView {
  return {
    clientId: client.id,
    username: client.username,
    displayName: client.displayName,
    userId: client.userId,
    placeId: client.placeId,
    executor: client.executor,
    connectedAt: new Date(client.connectedAt).toISOString(),
  };
}

/** The AI-facing shape of a selection resolution (which client a session targets). */
export type ResolutionView =
  | { readonly status: "resolved"; readonly client: ClientView }
  | { readonly status: "none"; readonly reason: "no-clients" | "selection-offline" }
  | { readonly status: "ambiguous"; readonly candidates: readonly ClientView[] };

/** Project a domain {@link SelectionResolution} to a JSON-friendly view. */
export function toResolutionView(resolution: SelectionResolution): ResolutionView {
  switch (resolution.status) {
    case "resolved":
      return { status: "resolved", client: toClientView(resolution.client) };
    case "none":
      return { status: "none", reason: resolution.reason };
    case "ambiguous":
      return { status: "ambiguous", candidates: resolution.candidates.map(toClientView) };
  }
}
