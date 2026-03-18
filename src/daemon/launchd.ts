import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { colorize, isRich, theme } from "../terminal/theme.js";
import {
  formatGatewayServiceDescription,
  GATEWAY_LAUNCH_AGENT_LABEL,
  LEGACY_GATEWAY_LAUNCH_AGENT_LABELS,
  resolveGatewayLaunchAgentLabel,
} from "./constants.js";
import {
  buildLaunchAgentPlist as buildLaunchAgentPlistImpl,
  readLaunchAgentProgramArgumentsFromFile,
} from "./launchd-plist.js";
import { parseKeyValueOutput } from "./runtime-parse.js";
import type { GatewayServiceRuntime } from "./service-runtime.js";
import { resolveGatewayStateDir, resolveHomeDir } from "./paths.js";

const execFileAsync = promisify(execFile);
const toPosixPath = (value: string) => value.replace(/\\/g, "/");

const formatLine = (label: string, value: string) => {
  const rich = isRich();
  return `${colorize(rich, theme.muted, `${label}:`)} ${colorize(rich, theme.command, value)}`;
};

function resolveLaunchAgentLabel(args?: { env?: Record<string, string | undefined> }): string {
  const envLabel = args?.env?.OPENCLAW_LAUNCHD_LABEL?.trim();
  if (envLabel) return envLabel;
  return resolveGatewayLaunchAgentLabel(args?.env?.OPENCLAW_PROFILE);
}

function resolveLaunchAgentPlistPathForLabel(
  env: Record<string, string | undefined>,
  label: string,
): string {
  const home = toPosixPath(resolveHomeDir(env));
  return path.posix.join(home, "Library", "LaunchAgents", `${label}.plist`);
}

export function resolveLaunchAgentPlistPath(env: Record<string, string | undefined>): string {
  const label = resolveLaunchAgentLabel({ env });
  return resolveLaunchAgentPlistPathForLabel(env, label);
}

export function resolveGatewayLogPaths(env: Record<string, string | undefined>): {
  logDir: string;
  stdoutPath: string;
  stderrPath: string;
} {
  const stateDir = resolveGatewayStateDir(env);
  const logDir = path.join(stateDir, "logs");
  const prefix = env.OPENCLAW_LOG_PREFIX?.trim() || "gateway";
  return {
    logDir,
    stdoutPath: path.join(logDir, `${prefix}.log`),
    stderrPath: path.join(logDir, `${prefix}.err.log`),
  };
}

export async function readLaunchAgentProgramArguments(
  env: Record<string, string | undefined>,
): Promise<{
  programArguments: string[];
  workingDirectory?: string;
  environment?: Record<string, string>;
  sourcePath?: string;
} | null> {
  const plistPath = resolveLaunchAgentPlistPath(env);
  return readLaunchAgentProgramArgumentsFromFile(plistPath);
}

export function buildLaunchAgentPlist({
  label = GATEWAY_LAUNCH_AGENT_LABEL,
  comment,
  programArguments,
  workingDirectory,
  stdoutPath,
  stderrPath,
  environment,
}: {
  label?: string;
  comment?: string;
  programArguments: string[];
  workingDirectory?: string;
  stdoutPath: string;
  stderrPath: string;
  environment?: Record<string, string | undefined>;
}): string {
  return buildLaunchAgentPlistImpl({
    label,
    comment,
    programArguments,
    workingDirectory,
    stdoutPath,
    stderrPath,
    environment,
  });
}

async function execLaunchctl(
  args: string[],
): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const { stdout, stderr } = await execFileAsync("launchctl", args, {
      encoding: "utf8",
    });
    return {
      stdout: String(stdout ?? ""),
      stderr: String(stderr ?? ""),
      code: 0,
    };
  } catch (error) {
    const e = error as {
      stdout?: unknown;
      stderr?: unknown;
      code?: unknown;
      message?: unknown;
    };
    return {
      stdout: typeof e.stdout === "string" ? e.stdout : "",
      stderr:
        typeof e.stderr === "string" ? e.stderr : typeof e.message === "string" ? e.message : "",
      code: typeof e.code === "number" ? e.code : 1,
    };
  }
}

function resolveEffectiveUid(): number {
  // When invoked via `sudo`, process.getuid() returns 0 (root), but LaunchAgents belong
  // to the original user. Use SUDO_UID if present so operations target the correct user.
  const sudoUid = process.env.SUDO_UID;
  if (sudoUid && /^\d+$/.test(sudoUid)) return Number.parseInt(sudoUid, 10);
  if (typeof process.getuid !== "function") return 501;
  return process.getuid();
}

function resolveGuiDomain(): string {
  return `gui/${resolveEffectiveUid()}`;
}

// The user/<uid> domain always exists for all users (not tied to a GUI session).
// LaunchAgents loaded via `launchctl load` from SSH sessions land here.
function resolveUserDomain(): string {
  return `user/${resolveEffectiveUid()}`;
}

export type LaunchctlPrintInfo = {
  state?: string;
  pid?: number;
  lastExitStatus?: number;
  lastExitReason?: string;
};

export function parseLaunchctlPrint(output: string): LaunchctlPrintInfo {
  const entries = parseKeyValueOutput(output, "=");
  const info: LaunchctlPrintInfo = {};
  const state = entries.state;
  if (state) info.state = state;
  const pidValue = entries.pid;
  if (pidValue) {
    const pid = Number.parseInt(pidValue, 10);
    if (Number.isFinite(pid)) info.pid = pid;
  }
  const exitStatusValue = entries["last exit status"];
  if (exitStatusValue) {
    const status = Number.parseInt(exitStatusValue, 10);
    if (Number.isFinite(status)) info.lastExitStatus = status;
  }
  const exitReason = entries["last exit reason"];
  if (exitReason) info.lastExitReason = exitReason;
  return info;
}

export async function isLaunchAgentLoaded(args: {
  env?: Record<string, string | undefined>;
}): Promise<boolean> {
  const label = resolveLaunchAgentLabel({ env: args.env });
  // `launchctl list <label>` is the most reliable cross-context check (works from SSH,
  // GUI, sudo, and regardless of how the service was loaded — bootstrap or legacy load).
  const listRes = await execLaunchctl(["list", label]);
  if (listRes.code === 0) return true;
  // Fallback: check domain-specific print for newer macOS.
  for (const domain of [resolveGuiDomain(), resolveUserDomain()]) {
    const res = await execLaunchctl(["print", `${domain}/${label}`]);
    if (res.code === 0) return true;
  }
  return false;
}

export async function isLaunchAgentListed(args: {
  env?: Record<string, string | undefined>;
}): Promise<boolean> {
  const label = resolveLaunchAgentLabel({ env: args.env });
  const res = await execLaunchctl(["list"]);
  if (res.code !== 0) return false;
  return res.stdout.split(/\r?\n/).some((line) => line.trim().split(/\s+/).at(-1) === label);
}

export async function launchAgentPlistExists(
  env: Record<string, string | undefined>,
): Promise<boolean> {
  try {
    const plistPath = resolveLaunchAgentPlistPath(env);
    await fs.access(plistPath);
    return true;
  } catch {
    return false;
  }
}

export async function readLaunchAgentRuntime(
  env: Record<string, string | undefined>,
): Promise<GatewayServiceRuntime> {
  const label = resolveLaunchAgentLabel({ env });
  // Try gui/<uid> first; fall back to user/<uid> for SSH/no-GUI installs.
  let res = await execLaunchctl(["print", `${resolveGuiDomain()}/${label}`]);
  if (res.code !== 0) {
    res = await execLaunchctl(["print", `${resolveUserDomain()}/${label}`]);
  }
  if (res.code !== 0) {
    return {
      status: "unknown",
      detail: (res.stderr || res.stdout).trim() || undefined,
      missingUnit: true,
    };
  }
  const parsed = parseLaunchctlPrint(res.stdout || res.stderr || "");
  const plistExists = await launchAgentPlistExists(env);
  const state = parsed.state?.toLowerCase();
  const status = state === "running" || parsed.pid ? "running" : state ? "stopped" : "unknown";
  return {
    status,
    state: parsed.state,
    pid: parsed.pid,
    lastExitStatus: parsed.lastExitStatus,
    lastExitReason: parsed.lastExitReason,
    cachedLabel: !plistExists,
  };
}

export async function repairLaunchAgentBootstrap(args: {
  env?: Record<string, string | undefined>;
}): Promise<{ ok: boolean; detail?: string }> {
  const env = args.env ?? (process.env as Record<string, string | undefined>);
  const domain = resolveGuiDomain();
  const label = resolveLaunchAgentLabel({ env });
  const plistPath = resolveLaunchAgentPlistPath(env);
  const boot = await execLaunchctl(["bootstrap", domain, plistPath]);
  if (boot.code !== 0) {
    return { ok: false, detail: (boot.stderr || boot.stdout).trim() || undefined };
  }
  const kick = await execLaunchctl(["kickstart", "-k", `${domain}/${label}`]);
  if (kick.code !== 0) {
    return { ok: false, detail: (kick.stderr || kick.stdout).trim() || undefined };
  }
  return { ok: true };
}

export type LegacyLaunchAgent = {
  label: string;
  plistPath: string;
  loaded: boolean;
  exists: boolean;
};

export async function findLegacyLaunchAgents(
  env: Record<string, string | undefined>,
): Promise<LegacyLaunchAgent[]> {
  const results: LegacyLaunchAgent[] = [];
  for (const label of LEGACY_GATEWAY_LAUNCH_AGENT_LABELS) {
    const plistPath = resolveLaunchAgentPlistPathForLabel(env, label);
    // `launchctl list <label>` is the most reliable cross-context check.
    let loaded = false;
    const listRes = await execLaunchctl(["list", label]);
    if (listRes.code === 0) {
      loaded = true;
    } else {
      // Fallback: domain-specific print.
      for (const domain of [resolveGuiDomain(), resolveUserDomain()]) {
        const res = await execLaunchctl(["print", `${domain}/${label}`]);
        if (res.code === 0) {
          loaded = true;
          break;
        }
      }
    }
    let exists = false;
    try {
      await fs.access(plistPath);
      exists = true;
    } catch {
      // ignore
    }
    if (loaded || exists) {
      results.push({ label, plistPath, loaded, exists });
    }
  }
  return results;
}

export async function uninstallLegacyLaunchAgents({
  env,
  stdout,
}: {
  env: Record<string, string | undefined>;
  stdout: NodeJS.WritableStream;
}): Promise<LegacyLaunchAgent[]> {
  const agents = await findLegacyLaunchAgents(env);
  if (agents.length === 0) return agents;

  const home = resolveHomeDir(env);
  const trashDir = path.join(home, ".Trash");
  try {
    await fs.mkdir(trashDir, { recursive: true });
  } catch {
    // ignore
  }

  for (const agent of agents) {
    // `launchctl remove` is cross-context and stops the service regardless of domain.
    await execLaunchctl(["remove", agent.label]);
    for (const domain of [resolveGuiDomain(), resolveUserDomain()]) {
      await execLaunchctl(["bootout", domain, agent.plistPath]);
      await execLaunchctl(["bootout", `${domain}/${agent.label}`]);
    }
    await execLaunchctl(["unload", agent.plistPath]);

    try {
      await fs.access(agent.plistPath);
    } catch {
      continue;
    }

    const dest = path.join(trashDir, `${agent.label}.plist`);
    try {
      await fs.rename(agent.plistPath, dest);
      stdout.write(`${formatLine("Moved legacy LaunchAgent to Trash", dest)}\n`);
    } catch {
      stdout.write(`Legacy LaunchAgent remains at ${agent.plistPath} (could not move)\n`);
    }
  }

  return agents;
}

export async function uninstallLaunchAgent({
  env,
  stdout,
}: {
  env: Record<string, string | undefined>;
  stdout: NodeJS.WritableStream;
}): Promise<void> {
  const label = resolveLaunchAgentLabel({ env });
  const plistPath = resolveLaunchAgentPlistPath(env);
  // `launchctl remove` is cross-context and stops the service regardless of domain.
  await execLaunchctl(["remove", label]);
  // Belt-and-suspenders: also try domain-specific bootout and legacy unload.
  for (const domain of [resolveGuiDomain(), resolveUserDomain()]) {
    await execLaunchctl(["bootout", domain, plistPath]);
    await execLaunchctl(["bootout", `${domain}/${label}`]);
  }
  await execLaunchctl(["unload", plistPath]);

  try {
    await fs.access(plistPath);
  } catch {
    stdout.write(`LaunchAgent not found at ${plistPath}\n`);
    return;
  }

  const home = resolveHomeDir(env);
  const trashDir = path.join(home, ".Trash");
  const dest = path.join(trashDir, `${label}.plist`);
  try {
    await fs.mkdir(trashDir, { recursive: true });
    await fs.rename(plistPath, dest);
    stdout.write(`${formatLine("Moved LaunchAgent to Trash", dest)}\n`);
  } catch {
    stdout.write(`LaunchAgent remains at ${plistPath} (could not move)\n`);
  }
}

function isLaunchctlNotLoaded(res: { stdout: string; stderr: string; code: number }): boolean {
  const detail = `${res.stderr || res.stdout}`.toLowerCase();
  return (
    detail.includes("no such process") ||
    detail.includes("could not find service") ||
    detail.includes("not found")
  );
}

export async function stopLaunchAgent({
  stdout,
  env,
}: {
  stdout: NodeJS.WritableStream;
  env?: Record<string, string | undefined>;
}): Promise<void> {
  const label = resolveLaunchAgentLabel({ env });
  // `launchctl remove` is the most reliable cross-context stop mechanism.
  const removeRes = await execLaunchctl(["remove", label]);
  let stopped = removeRes.code === 0 || isLaunchctlNotLoaded(removeRes);
  // Belt-and-suspenders: also try domain-specific bootout.
  for (const domain of [resolveGuiDomain(), resolveUserDomain()]) {
    const res = await execLaunchctl(["bootout", `${domain}/${label}`]);
    if (res.code === 0 || isLaunchctlNotLoaded(res)) stopped = true;
  }
  if (!stopped) throw new Error(`launchctl stop failed for ${label}`);
  stdout.write(`${formatLine("Stopped LaunchAgent", label)}\n`);
}

export async function installLaunchAgent({
  env,
  stdout,
  programArguments,
  workingDirectory,
  environment,
  description,
}: {
  env: Record<string, string | undefined>;
  stdout: NodeJS.WritableStream;
  programArguments: string[];
  workingDirectory?: string;
  environment?: Record<string, string | undefined>;
  description?: string;
}): Promise<{ plistPath: string }> {
  const { logDir, stdoutPath, stderrPath } = resolveGatewayLogPaths(env);
  await fs.mkdir(logDir, { recursive: true });

  const label = resolveLaunchAgentLabel({ env });
  const plistPath = resolveLaunchAgentPlistPathForLabel(env, label);

  // Clean up legacy labels.
  // IMPORTANT: skip the current label — it is handled separately below.
  for (const legacyLabel of LEGACY_GATEWAY_LAUNCH_AGENT_LABELS) {
    if (legacyLabel === label) continue;
    const legacyPlistPath = resolveLaunchAgentPlistPathForLabel(env, legacyLabel);
    // `launchctl remove` is cross-context: works from SSH, GUI, sudo, and regardless
    // of whether the service was loaded via bootstrap or legacy load.
    await execLaunchctl(["remove", legacyLabel]);
    for (const domain of [resolveGuiDomain(), resolveUserDomain()]) {
      await execLaunchctl(["bootout", `${domain}/${legacyLabel}`]);
    }
    await execLaunchctl(["unload", "-w", legacyPlistPath]);
    try {
      await fs.unlink(legacyPlistPath);
    } catch {
      // ignore
    }
  }

  await fs.mkdir(path.dirname(plistPath), { recursive: true });

  // --- Teardown BEFORE writing new plist ---
  // `launchctl remove` is the most reliable way to stop + unregister a service
  // regardless of which launchd domain (gui/<uid>, user/<uid>) loaded it.
  // It works from SSH sessions even for services loaded in a GUI login session.
  await execLaunchctl(["remove", label]);
  // Belt-and-suspenders: also try domain-specific bootout and legacy unload.
  for (const d of [resolveGuiDomain(), resolveUserDomain()]) {
    await execLaunchctl(["bootout", `${d}/${label}`]);
    await execLaunchctl(["bootout", d, plistPath]);
  }
  await execLaunchctl(["unload", "-w", plistPath]);

  // --- Write new plist ---
  const serviceDescription =
    description ??
    formatGatewayServiceDescription({
      profile: env.OPENCLAW_PROFILE,
      version: environment?.OPENCLAW_SERVICE_VERSION ?? env.OPENCLAW_SERVICE_VERSION,
    });
  const plist = buildLaunchAgentPlist({
    label,
    comment: serviceDescription,
    programArguments,
    workingDirectory,
    stdoutPath,
    stderrPath,
    environment,
  });
  await fs.writeFile(plistPath, plist, "utf8");

  // --- Load new plist ---
  // Try gui/<uid> first (active GUI session), then user/<uid> (SSH / no GUI session).
  // launchd can persist "disabled" state even after bootout; clear it before bootstrap.
  const guiDomain = resolveGuiDomain();
  const userDomain = resolveUserDomain();
  await execLaunchctl(["enable", `${guiDomain}/${label}`]);
  await execLaunchctl(["enable", `${userDomain}/${label}`]);

  let bootstrapDomain: string | null = null;
  for (const d of [guiDomain, userDomain]) {
    const boot = await execLaunchctl(["bootstrap", d, plistPath]);
    if (boot.code === 0) {
      bootstrapDomain = d;
      break;
    }
  }

  if (bootstrapDomain !== null) {
    await execLaunchctl(["kickstart", "-k", `${bootstrapDomain}/${label}`]);
  } else {
    // Both bootstrap domains failed. Last-resort: legacy launchctl load.
    // unload -w was already called above, so load -w will NOT be a no-op here.
    const load = await execLaunchctl(["load", "-w", plistPath]);
    if (load.code !== 0) {
      const guiBoot = await execLaunchctl(["bootstrap", guiDomain, plistPath]);
      const userBoot = await execLaunchctl(["bootstrap", userDomain, plistPath]);
      throw new Error(
        `Gateway service install failed. Bootstrap errors:\n` +
          `  gui: ${(guiBoot.stderr || guiBoot.stdout).trim()}\n` +
          `  user: ${(userBoot.stderr || userBoot.stdout).trim()}\n` +
          `  load: ${(load.stderr || load.stdout).trim()}\n` +
          `The plist has been written to ${plistPath}.`,
      );
    }
  }

  // Ensure we don't end up writing to a clack spinner line (wizards show progress without a newline).
  stdout.write("\n");
  stdout.write(`${formatLine("Installed LaunchAgent", plistPath)}\n`);
  stdout.write(`${formatLine("Logs", stdoutPath)}\n`);
  return { plistPath };
}

export async function restartLaunchAgent({
  stdout,
  env,
}: {
  stdout: NodeJS.WritableStream;
  env?: Record<string, string | undefined>;
}): Promise<void> {
  const domain = resolveGuiDomain();
  const label = resolveLaunchAgentLabel({ env });
  const res = await execLaunchctl(["kickstart", "-k", `${domain}/${label}`]);
  if (res.code !== 0) {
    throw new Error(`launchctl kickstart failed: ${res.stderr || res.stdout}`.trim());
  }
  stdout.write(`${formatLine("Restarted LaunchAgent", `${domain}/${label}`)}\n`);
}
