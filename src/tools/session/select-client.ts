import { z } from "zod";
import { ValidationError } from "../../domain/errors/errors.js";
import { isSameAccount } from "../../domain/client/client.js";
import { ClientId, UserId } from "../../domain/shared/ids.js";
import { defineTool } from "../../application/tool/define-tool.js";
import { toClientView, toResolutionView } from "../_shared/client-view.js";

export default defineTool({
  name: "select-client",
  title: "Bind this session to a Roblox client (account-sticky)",
  description:
    "Bind a connected Roblox client to THIS session so your tool calls target that game. Select by clientId OR " +
    "by username — selecting by username is recommended because it is account-sticky: a client gets a new clientId " +
    "every reconnect, but a username binding follows the account across rejoins without re-selecting. " +
    "Each session keeps its own selection, so two sessions can drive two games at once. " +
    "Provide exactly one of clientId or username; the value must match a currently-connected client.",
  category: "Session & Client",
  input: z
    .object({
      clientId: z.string().min(1).optional(),
      username: z.string().min(1).optional(),
    })
    .refine((v) => v.clientId !== undefined || v.username !== undefined, {
      message: "Provide a clientId or a username.",
    }),
  requiresClient: false,
  async execute({ clientId, username }, ctx) {
    const clients = ctx.clients.list();
    if (clients.length === 0) {
      throw new ValidationError(
        "No Roblox clients are connected. Run the loader in your executor first.",
      );
    }

    if (clientId !== undefined) {
      const target = clients.find((c) => c.id === clientId);
      if (!target) {
        throw new ValidationError(`No connected client has clientId "${clientId}".`, {
          connected: clients.map((c) => c.id),
        });
      }
      // Pin the exact connection, but also key on the account so the binding
      // survives a reconnect under a new clientId.
      ctx.session.select({
        clientId: ClientId(target.id),
        ...(target.userId !== null ? { userId: UserId(target.userId) } : {}),
        ...(target.username !== null ? { username: target.username } : {}),
      });
      const resolution = toResolutionView(ctx.session.resolve());
      return {
        data: { selected: toClientView(target), resolution },
        summary: `Session bound to ${target.username ?? target.id} (account-sticky).`,
      };
    }

    // username !== undefined here (the schema refine guarantees one field is set).
    const lower = username!.toLowerCase();
    const matches = clients.filter(
      (c) => c.username !== null && c.username.toLowerCase() === lower,
    );
    if (matches.length === 0) {
      throw new ValidationError(`No connected client matched username "${username}".`, {
        connected: clients.map((c) => c.username).filter((u): u is string => u !== null),
      });
    }
    // Same account on several windows -> most-recently-connected wins.
    const target = matches.reduce((a, b) => (b.connectedAt > a.connectedAt ? b : a));

    ctx.session.select({
      ...(target.userId !== null ? { userId: UserId(target.userId) } : {}),
      username: target.username ?? username!,
    });
    const resolution = toResolutionView(ctx.session.resolve());
    const distinct = matches.filter(
      (c, i) => matches.findIndex((o) => isSameAccount(o, c)) === i,
    ).length;

    return {
      data: { selected: toClientView(target), resolution },
      summary:
        `Session bound to ${target.username ?? username} (account-sticky` +
        `${distinct > 1 || matches.length > 1 ? `, ${matches.length} matching window(s)` : ""}).`,
    };
  },
});
