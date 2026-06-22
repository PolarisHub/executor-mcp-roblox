import { spawn } from "node:child_process";
import type { HostShell, ShellResult } from "../../application/ports/host-shell.js";
import type { Logger } from "../../application/ports/logger.js";

/**
 * The production {@link HostShell}: runs a command via `node:child_process.spawn`
 * with the args passed as an array and `shell: false`, so arguments are never
 * re-parsed by a shell and cannot be injected. stdout/stderr are collected as
 * UTF-8; a non-zero (or null, on signal) exit is returned in `code` rather than
 * thrown. When `timeoutMs` elapses the child is killed and the partial output is
 * returned with `code: null`.
 */
export class ChildProcessShell implements HostShell {
  private readonly logger: Logger | undefined;

  constructor(options?: { logger?: Logger }) {
    this.logger = options?.logger;
  }

  run(
    command: string,
    args: readonly string[],
    options?: { timeoutMs?: number },
  ): Promise<ShellResult> {
    return new Promise<ShellResult>((resolvePromise, reject) => {
      const child = spawn(command, [...args], { shell: false, windowsHide: true });

      let stdout = "";
      let stderr = "";
      let settled = false;
      let timedOut = false;

      const timeoutMs = options?.timeoutMs;
      const timer =
        timeoutMs !== undefined && timeoutMs > 0
          ? setTimeout(() => {
              timedOut = true;
              this.logger?.warn({ command, timeoutMs }, "host shell command timed out; killing");
              child.kill("SIGKILL");
            }, timeoutMs)
          : undefined;

      const finish = (result: ShellResult): void => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        resolvePromise(result);
      };

      child.stdout?.setEncoding("utf8");
      child.stderr?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.stderr?.on("data", (chunk: string) => {
        stderr += chunk;
      });

      child.on("error", (err) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        reject(err);
      });

      child.on("close", (code) => {
        // On timeout we killed the child; surface a null code with partial output.
        finish({ stdout, stderr, code: timedOut ? null : code });
      });
    });
  }
}
