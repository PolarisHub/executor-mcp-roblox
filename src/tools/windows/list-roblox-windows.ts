import { z } from "zod";
import { defineTool } from "../../application/tool/define-tool.js";

/**
 * PowerShell that enumerates Roblox player processes that own a top-level window
 * and emits a JSON array of { pid, title }. Get-Process exposes MainWindowTitle
 * for the visible window, which is empty for background/minimized helper
 * processes — we filter those out. `ConvertTo-Json` collapses a single object,
 * so we wrap the result in @(...) and always emit an array.
 */
const ENUM_SCRIPT = `
$procs = Get-Process -Name 'RobloxPlayerBeta' -ErrorAction SilentlyContinue |
  Where-Object { $_.MainWindowTitle -ne '' } |
  ForEach-Object { [PSCustomObject]@{ pid = $_.Id; title = $_.MainWindowTitle } }
@($procs) | ConvertTo-Json -Compress
`.trim();

interface RawWindow {
  pid: number;
  title: string;
}

export default defineTool({
  name: "list-roblox-windows",
  title: "List Roblox OS windows",
  description:
    "List the Roblox player processes on the SERVER host that own a visible OS window, with their process id and " +
    "window title. Windows-only: runs a PowerShell `Get-Process RobloxPlayerBeta` query and returns the windows " +
    "that have a non-empty MainWindowTitle. Use this before screenshot-window when more than one Roblox window may " +
    "be open, to pick the right processId. Returns { windows: [{ pid, title }] } (empty if none are open).",
  category: "Windows",
  requiresClient: false,
  input: z.object({}),
  async execute(_input, ctx) {
    const { stdout, stderr, code } = await ctx.host.shell.run(
      "powershell",
      ["-NoProfile", "-NonInteractive", "-Command", ENUM_SCRIPT],
      { timeoutMs: 15000 },
    );

    if (code !== 0) {
      return {
        data: {
          error: `Window enumeration failed (exit ${code ?? "killed"}).`,
          stderr: stderr.trim(),
        },
        isError: true,
      };
    }

    const raw = stdout.trim();
    if (!raw || raw === "null") {
      return { data: { windows: [] }, summary: "No Roblox windows found." };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (cause) {
      return {
        data: {
          error: `Could not parse window list: ${cause instanceof Error ? cause.message : String(cause)}`,
          raw,
        },
        isError: true,
      };
    }

    const list = (Array.isArray(parsed) ? parsed : [parsed]) as RawWindow[];
    const windows = list
      .filter((w): w is RawWindow => w != null && typeof w.pid === "number")
      .map((w) => ({ pid: w.pid, title: String(w.title ?? "") }));

    return {
      data: { windows },
      summary:
        windows.length === 0
          ? "No Roblox windows found."
          : `${windows.length} Roblox window(s) found.`,
    };
  },
});
