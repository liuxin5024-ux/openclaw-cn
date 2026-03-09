import { execFile, spawn } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { danger, shouldLogVerbose } from "../globals.js";
import { logDebug, logError } from "../logger.js";
import { resolveCommandStdio } from "./spawn-utils.js";

const execFileAsync = promisify(execFile);

/**
 * Resolves a command + argv for Windows compatibility.
 * On Windows, .cmd/.bat files cannot be spawned directly without a shell;
 * we wrap them via `cmd.exe /d /s /c` with a fixed, trusted argv so there
 * is no shell-injection risk (the arguments are never user-controlled here).
 * Returns { command, args } where args already includes the original argv slice.
 */
function resolveCommandArgv(command: string, args: string[]): { command: string; args: string[] } {
  if (process.platform !== "win32") {
    return { command, args };
  }
  const basename = path.basename(command).toLowerCase();
  const ext = path.extname(basename);
  // Already a .cmd/.bat: wrap with cmd.exe
  if (ext === ".cmd" || ext === ".bat") {
    return { command: "cmd.exe", args: ["/d", "/s", "/c", command, ...args] };
  }
  // Bare name with no extension: check if a .cmd shim exists on PATH
  if (!ext) {
    const cmdCommands = ["npm", "pnpm", "yarn", "npx"];
    if (cmdCommands.includes(basename)) {
      const cmdShim = `${command}.cmd`;
      return { command: "cmd.exe", args: ["/d", "/s", "/c", cmdShim, ...args] };
    }
  }
  return { command, args };
}

/** @deprecated use resolveCommandArgv */
function resolveCommand(command: string): string {
  return resolveCommandArgv(command, []).command;
}

export function shouldSpawnWithShell(params: {
  resolvedCommand: string;
  platform: NodeJS.Platform;
}): boolean {
  // SECURITY: never enable `shell` for argv-based execution.
  // `shell` routes through cmd.exe on Windows, which turns untrusted argv values
  // (like chat prompts passed as CLI args) into command-injection primitives.
  // If you need a shell, use an explicit shell-wrapper argv (e.g. `cmd.exe /c ...`)
  // and validate/escape at the call site.
  void params;
  return false;
}

// Simple promise-wrapped execFile with optional verbosity logging.
export async function runExec(
  command: string,
  args: string[],
  opts: number | { timeoutMs?: number; maxBuffer?: number } = 10_000,
): Promise<{ stdout: string; stderr: string }> {
  const options =
    typeof opts === "number"
      ? { timeout: opts, encoding: "utf8" as const }
      : {
          timeout: opts.timeoutMs,
          maxBuffer: opts.maxBuffer,
          encoding: "utf8" as const,
        };
  try {
    const { stdout, stderr } = await execFileAsync(resolveCommand(command), args, options);
    if (shouldLogVerbose()) {
      if (stdout.trim()) {
        logDebug(stdout.trim());
      }
      if (stderr.trim()) {
        logError(stderr.trim());
      }
    }
    return { stdout, stderr };
  } catch (err) {
    if (shouldLogVerbose()) {
      logError(danger(`Command failed: ${command} ${args.join(" ")}`));
    }
    throw err;
  }
}

export type SpawnResult = {
  stdout: string;
  stderr: string;
  code: number | null;
  signal: NodeJS.Signals | null;
  killed: boolean;
};

export type CommandOptions = {
  timeoutMs: number;
  cwd?: string;
  input?: string;
  env?: NodeJS.ProcessEnv;
  windowsVerbatimArguments?: boolean;
  /** When false, stdin is always piped (not inherited). Defaults to true.
   * Set to false for non-interactive subprocesses (e.g. npm pack in onboarding)
   * to avoid EINVAL on Windows when stdin is not a real TTY. */
  preferInheritStdin?: boolean;
};

export async function runCommandWithTimeout(
  argv: string[],
  optionsOrTimeout: number | CommandOptions,
): Promise<SpawnResult> {
  const options: CommandOptions =
    typeof optionsOrTimeout === "number" ? { timeoutMs: optionsOrTimeout } : optionsOrTimeout;
  const { timeoutMs, cwd, input, env } = options;
  const { windowsVerbatimArguments } = options;
  const hasInput = input !== undefined;

  const shouldSuppressNpmFund = (() => {
    const cmd = path.basename(argv[0] ?? "");
    if (cmd === "npm" || cmd === "npm.cmd" || cmd === "npm.exe") {
      return true;
    }
    if (cmd === "node" || cmd === "node.exe") {
      const script = argv[1] ?? "";
      return script.includes("npm-cli.js");
    }
    return false;
  })();

  const mergedEnv = env ? { ...process.env, ...env } : { ...process.env };
  const resolvedEnv = Object.fromEntries(
    Object.entries(mergedEnv)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => [key, String(value)]),
  );
  if (shouldSuppressNpmFund) {
    if (resolvedEnv.NPM_CONFIG_FUND == null) {
      resolvedEnv.NPM_CONFIG_FUND = "false";
    }
    if (resolvedEnv.npm_config_fund == null) {
      resolvedEnv.npm_config_fund = "false";
    }
  }

  const stdio = resolveCommandStdio({
    hasInput,
    preferInherit: options.preferInheritStdin !== false,
  });
  const { command: resolvedCommand, args: resolvedArgs } = resolveCommandArgv(
    argv[0] ?? "",
    argv.slice(1),
  );
  const child = spawn(resolvedCommand, resolvedArgs, {
    stdio,
    cwd,
    env: resolvedEnv,
    windowsVerbatimArguments,
  });
  // Spawn with inherited stdin (TTY) so tools like `pi` stay interactive when needed.
  return await new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (typeof child.kill === "function") {
        child.kill("SIGKILL");
      }
    }, timeoutMs);

    if (hasInput && child.stdin) {
      child.stdin.write(input ?? "");
      child.stdin.end();
    }

    child.stdout?.on("data", (d) => {
      stdout += d.toString();
    });
    child.stderr?.on("data", (d) => {
      stderr += d.toString();
    });
    child.on("error", (err) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code, signal) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, code, signal, killed: child.killed });
    });
  });
}
