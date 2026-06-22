export interface ShellResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number | null;
}

/**
 * Runs a command on the SERVER host (the machine the MCP server runs on, which is
 * also where the Roblox client runs). Used by OS-level tools — e.g. enumerating or
 * screenshotting Roblox windows — that operate outside the game sandbox. The
 * adapter decides the concrete shell; tools never build raw OS process calls.
 */
export interface HostShell {
  run(
    command: string,
    args: readonly string[],
    options?: { timeoutMs?: number },
  ): Promise<ShellResult>;
}
