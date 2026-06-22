import { z } from "zod";
import { defineTool } from "../../application/tool/define-tool.js";
import { q } from "../_shared/luau.js";

/** ~100 KB cap on the returned body so a large response can't blow up the result. */
const BODY_CAP = 100 * 1024;

/**
 * Make a real outbound HTTP request from the game client via the executor's
 * request({ Url, Method, Headers, Body }) function (falling back to http_request,
 * then syn.request). Returns the standard response shape.
 */
export default defineTool({
  name: "http-request",
  title: "Make an outbound HTTP request from the client (sUNC request)",
  description:
    "SENDS A REAL OUTBOUND HTTP REQUEST from the Roblox client via the executor's request({ Url, Method, Headers, " +
    "Body }) (falling back to http_request, then syn.request). Unlike Roblox's HttpService this can hit arbitrary " +
    "hosts and set custom headers. The response body is capped at ~100 KB. Requires a Volt-class executor exposing " +
    "one of these functions. The call is type-guarded and pcall-wrapped: if none is present you get " +
    "{ error = 'request is not available in this executor.' }, and a transport failure returns { error }. Returns " +
    "{ statusCode, success, headers, body, statusMessage } or { error }.",
  category: "Network",
  mutatesState: true,
  input: z.object({
    url: z.string().describe("The absolute request URL, e.g. 'https://api.example.com/v1/thing'."),
    method: z
      .enum(["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD"])
      .optional()
      .default("GET")
      .describe("HTTP method (default GET)."),
    headers: z
      .record(z.string(), z.string())
      .optional()
      .describe("Optional request headers as a string->string map."),
    body: z.string().optional().describe("Optional request body (for POST/PUT/PATCH)."),
    threadContext: z.number().int().optional(),
    timeoutMs: z.number().int().optional(),
  }),
  async execute({ url, method, headers, body, threadContext, timeoutMs }, ctx) {
    const headerLines = headers
      ? Object.entries(headers)
          .map(([k, v]) => `  [${q(k)}] = ${q(v)},`)
          .join("\n")
      : "";
    const bodyLine = body === undefined ? "" : `  Body = ${q(body)},`;

    const source = `
local fn = nil
if type(request) == "function" then
  fn = request
elseif type(http_request) == "function" then
  fn = http_request
elseif type(syn) == "table" and type(syn.request) == "function" then
  fn = syn.request
end
if type(fn) ~= "function" then
  return { error = "request is not available in this executor." }
end

local opts = {
  Url = ${q(url)},
  Method = ${q(method)},
  Headers = {
${headerLines}
  },
${bodyLine}
}

local ok, response = pcall(fn, opts)
if not ok then return { error = "request failed: " .. tostring(response) } end
if type(response) ~= "table" then return { error = "request returned a non-table response." } end

local body = response.Body
if type(body) == "string" and #body > ${BODY_CAP} then
  body = body:sub(1, ${BODY_CAP})
end

return {
  statusCode = response.StatusCode,
  success = response.Success,
  headers = response.Headers,
  body = body,
  statusMessage = response.StatusMessage,
}
`;
    const data = await ctx.runLuau(source, {
      threadContext,
      timeoutMs: timeoutMs ?? 30000,
    });
    return { data };
  },
});
