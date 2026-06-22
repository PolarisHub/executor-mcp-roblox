import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { defineTool } from "../../application/tool/define-tool.js";

/**
 * Quote an arbitrary string as a PowerShell single-quoted literal. Inside a
 * single-quoted PowerShell string nothing expands (no `$`, no backtick, no
 * subexpressions), so the only escape needed is to double an embedded single
 * quote. This makes it safe to embed a window title or output path that a caller
 * controls — they cannot break out of the literal to inject commands.
 */
function psSingleQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Build the PowerShell capture script. The target window is located by process
 * id or by a case-insensitive title substring; its on-screen rectangle is read
 * via the user32 `GetWindowRect` P/Invoke, and the pixels are copied with
 * `System.Drawing.Graphics.CopyFromScreen` and saved as a PNG. On success the
 * script prints one JSON line { savedPath, width, height }; on any failure it
 * prints { error }. The three varying values (out path, title, pid) are embedded
 * as safely-quoted literals — see {@link psSingleQuote} — so a hostile title or
 * path cannot inject PowerShell.
 */
function buildCaptureScript(args: {
  outPath: string;
  windowTitle?: string;
  processId?: number;
}): string {
  const outLiteral = psSingleQuote(args.outPath);
  const titleLiteral = args.windowTitle !== undefined ? psSingleQuote(args.windowTitle) : "$null";
  // processId is constrained to a number by the schema; emit it as a bare int
  // (or $null) so it is never a string that could carry a payload.
  const pidLiteral = args.processId !== undefined ? String(Math.trunc(args.processId)) : "$null";

  return `
$ErrorActionPreference = 'Stop'
try {
  Add-Type -AssemblyName System.Drawing
  Add-Type @"
using System;
using System.Runtime.InteropServices;
public class WinShot {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
}
"@

  $outPath = ${outLiteral}
  $wantTitle = ${titleLiteral}
  $wantPid = ${pidLiteral}

  $procs = Get-Process -Name 'RobloxPlayerBeta' -ErrorAction SilentlyContinue |
    Where-Object { $_.MainWindowHandle -ne 0 }
  if ($null -ne $wantPid) {
    $procs = $procs | Where-Object { $_.Id -eq $wantPid }
  } elseif ($null -ne $wantTitle) {
    $procs = $procs | Where-Object { $_.MainWindowTitle -like ('*' + $wantTitle + '*') }
  }

  $target = $procs | Select-Object -First 1
  if ($null -eq $target) {
    [Console]::Out.WriteLine((@{ error = 'No matching Roblox window found.' } | ConvertTo-Json -Compress))
    exit 0
  }

  $hwnd = $target.MainWindowHandle
  if ([WinShot]::IsIconic($hwnd)) { [WinShot]::ShowWindow($hwnd, 9) | Out-Null; Start-Sleep -Milliseconds 200 }
  [WinShot]::SetForegroundWindow($hwnd) | Out-Null
  Start-Sleep -Milliseconds 150

  $rect = New-Object WinShot+RECT
  [WinShot]::GetWindowRect($hwnd, [ref]$rect) | Out-Null
  $w = $rect.Right - $rect.Left
  $h = $rect.Bottom - $rect.Top
  if ($w -le 0 -or $h -le 0) {
    [Console]::Out.WriteLine((@{ error = 'Target window has zero size.' } | ConvertTo-Json -Compress))
    exit 0
  }

  $bmp = New-Object System.Drawing.Bitmap($w, $h)
  $gfx = [System.Drawing.Graphics]::FromImage($bmp)
  $gfx.CopyFromScreen($rect.Left, $rect.Top, 0, 0, (New-Object System.Drawing.Size($w, $h)))
  $bmp.Save($outPath, [System.Drawing.Imaging.ImageFormat]::Png)
  $gfx.Dispose(); $bmp.Dispose()

  [Console]::Out.WriteLine((@{ savedPath = $outPath; width = $w; height = $h } | ConvertTo-Json -Compress))
} catch {
  [Console]::Out.WriteLine((@{ error = $_.Exception.Message } | ConvertTo-Json -Compress))
}
`.trim();
}

interface CaptureResult {
  savedPath?: string;
  width?: number;
  height?: number;
  error?: string;
}

export default defineTool({
  name: "screenshot-window",
  title: "Screenshot a Roblox window",
  description:
    "Capture an OS screenshot of a Roblox window on the SERVER host and save it as a PNG, returning the saved file " +
    "path and the captured width/height. Windows-only: locates the RobloxPlayerBeta window by `processId` or by a " +
    "`windowTitle` substring (the single Roblox window if neither is given), reads its rectangle via the user32 " +
    "GetWindowRect API, and copies the pixels with System.Drawing.CopyFromScreen. Provide `savePath` to choose the " +
    "output file, otherwise a PNG is written to the system temp directory. Use list-roblox-windows first when " +
    "several windows are open. Returns { savedPath, width, height }.",
  category: "Windows",
  requiresClient: false,
  mutatesState: false,
  input: z.object({
    windowTitle: z
      .string()
      .optional()
      .describe("Case-insensitive substring of the target window's title."),
    processId: z.number().optional().describe("Exact process id of the target Roblox window."),
    savePath: z
      .string()
      .optional()
      .describe("Destination .png path. Defaults to a file in the system temp directory."),
  }),
  async execute({ windowTitle, processId, savePath }, ctx) {
    const outPath = savePath ?? join(tmpdir(), `roblox-screenshot-${Date.now()}.png`);
    const script = buildCaptureScript({
      outPath,
      ...(windowTitle !== undefined ? { windowTitle } : {}),
      ...(processId !== undefined ? { processId } : {}),
    });

    const { stdout, stderr, code } = await ctx.host.shell.run(
      "powershell",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { timeoutMs: 20000 },
    );

    if (code !== 0) {
      return {
        data: { error: `Screenshot failed (exit ${code ?? "killed"}).`, stderr: stderr.trim() },
        isError: true,
      };
    }

    const raw = stdout.trim();
    let parsed: CaptureResult;
    try {
      parsed = JSON.parse(raw) as CaptureResult;
    } catch (cause) {
      return {
        data: {
          error: `Could not parse screenshot result: ${cause instanceof Error ? cause.message : String(cause)}`,
          raw,
        },
        isError: true,
      };
    }

    if (parsed.error) {
      return { data: { error: parsed.error }, isError: true };
    }

    return {
      data: { savedPath: parsed.savedPath, width: parsed.width, height: parsed.height },
      summary: `Saved ${parsed.width}x${parsed.height} screenshot to ${parsed.savedPath}.`,
    };
  },
});
