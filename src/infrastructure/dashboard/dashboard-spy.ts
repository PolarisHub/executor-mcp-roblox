import { ClientNotFoundError } from "../../domain/errors/errors.js";
import { ClientId } from "../../domain/shared/ids.js";
import type { ClientDirectory } from "../../application/ports/client-directory.js";
import type { ExecutionGateway } from "../../application/ports/execution-gateway.js";

/**
 * Reads the remote-spy ring buffer that the `ensure-remote-spy` tool installs.
 * Mirrors the shape that `get-remote-spy-logs` returns so the dashboard can
 * poll/render without going through the MCP client.
 */
export class SpyService {
  constructor(
    private readonly gateway: ExecutionGateway,
    private readonly clients: ClientDirectory,
  ) {}

  logs(clientId: string, limit: number): Promise<unknown> {
    const id = ClientId(clientId);
    if (!this.clients.get(id)) {
      return Promise.reject(new ClientNotFoundError(`Client "${clientId}" is not connected.`));
    }
    const cap = Math.min(Math.max(Math.floor(limit), 1), 5000);
    const source = `
if type(getgenv) ~= "function" then return { error = "getgenv not available" } end
local genv = getgenv()
local st = genv.__mcp_remoteSpy
if type(st) ~= "table" or type(st.logs) ~= "table" then
  return { notRunning = true, count = 0, returned = 0, logs = {} }
end
local logs = st.logs
local total = #logs
local limit = ${cap}
local out = {}
local taken = 0
for i = total, 1, -1 do
  if taken >= limit then break end
  taken = taken + 1
  out[taken] = logs[i]
end
return {
  active = true,
  count = total,
  returned = taken,
  max = (type(st.max) == "number" and st.max) or nil,
  truncated = (taken < total),
  logs = out,
}
`;
    return this.gateway.eval(id, { source, threadContext: 8, timeoutMs: 8000 });
  }

  clear(clientId: string): Promise<unknown> {
    const id = ClientId(clientId);
    if (!this.clients.get(id)) {
      return Promise.reject(new ClientNotFoundError(`Client "${clientId}" is not connected.`));
    }
    const source = `
if type(getgenv) ~= "function" then return { error = "getgenv not available" } end
local st = getgenv().__mcp_remoteSpy
if type(st) ~= "table" or type(st.logs) ~= "table" then
  return { notRunning = true, cleared = 0 }
end
local n = #st.logs
table.clear(st.logs)
return { cleared = n }
`;
    return this.gateway.eval(id, { source, threadContext: 8, timeoutMs: 5000 });
  }
}
