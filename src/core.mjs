import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, hostname, platform, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

export const STATE_VERSION = 2;
export const HOOK_ID = "codex-concurrency-v2";
export const DEFAULT_CLAIM_TIMEOUT_MS = 10 * 60 * 1000;
export const MAX_CLAIM_TIMEOUT_MS = 10 * 60 * 1000;
export const DEFAULT_POLL_INTERVAL_MS = 5 * 1000;

export function createEmptyState() {
  return { version: STATE_VERSION, updatedAt: null, gates: {} };
}

export function normalizeResourceNames(values) {
  return [...new Set((values ?? []).filter((value) => typeof value === "string").map((value) => value.trim()).filter(Boolean))];
}

export function normalizeOwner(value) {
  if (!value || typeof value !== "object") return null;
  const required = ["provider", "sessionId", "turnId"];
  if (required.some((key) => typeof value[key] !== "string" || value[key].length === 0)) return null;
  if (value.provider !== "codex" && value.provider !== "claude") return null;
  return {
    provider: value.provider,
    sessionId: value.sessionId,
    turnId: value.turnId,
    transcriptPath: typeof value.transcriptPath === "string" ? value.transcriptPath : "",
    processFingerprint: value.processFingerprint && typeof value.processFingerprint === "object" ? value.processFingerprint : null,
    cwd: typeof value.cwd === "string" ? value.cwd : "",
    branch: typeof value.branch === "string" ? value.branch : "",
    label: typeof value.label === "string" ? value.label : "",
    claimedAt: typeof value.claimedAt === "string" ? value.claimedAt : "",
  };
}

export function normalizeState(value) {
  if (!value || typeof value !== "object" || value.version !== STATE_VERSION) return createEmptyState();
  const gates = {};
  if (value.gates && typeof value.gates === "object" && !Array.isArray(value.gates)) {
    for (const [resource, candidate] of Object.entries(value.gates)) {
      const owner = normalizeOwner(candidate);
      if (resource && owner) gates[resource] = owner;
    }
  }
  return {
    version: STATE_VERSION,
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : null,
    gates,
  };
}

export function sameOwner(left, right) {
  return left?.provider === right?.provider && left?.sessionId === right?.sessionId && left?.turnId === right?.turnId;
}

export function claimResources(state, resources, claimant, isActive = () => true) {
  const next = normalizeState(state);
  const names = normalizeResourceNames(resources);
  const blocked = [];
  let reclaimed = false;
  let alreadyOwned = false;
  let added = false;

  for (const resource of names) {
    const owner = next.gates[resource];
    if (!owner) {
      added = true;
      continue;
    }
    if (!isActive(owner)) {
      reclaimed = true;
      continue;
    }
    if (sameOwner(owner, claimant)) {
      alreadyOwned = true;
      continue;
    }
    blocked.push({ resource, owner });
  }

  if (blocked.length > 0) return { status: "blocked", state: next, blocked };
  for (const resource of names) next.gates[resource] = { ...claimant };
  next.updatedAt = new Date().toISOString();
  const status = reclaimed ? "reclaimed" : alreadyOwned && added ? "expanded" : alreadyOwned ? "already-owner" : "claimed";
  return { status, state: next, resources: names, owner: claimant };
}

export function pruneInactiveGateRecords(state, isActive) {
  const next = normalizeState(state);
  let changed = false;
  for (const [resource, owner] of Object.entries(next.gates)) {
    if (!isActive(owner)) {
      delete next.gates[resource];
      changed = true;
    }
  }
  if (changed) next.updatedAt = new Date().toISOString();
  return { state: next, changed };
}

function canonicalPath(value) {
  let path = resolve(value).replaceAll("\\", "/");
  if (platform() === "win32") path = path.toLowerCase();
  return path.replace(/\/$/, "");
}

export function repositoryId(gitCommonDir) {
  return createHash("sha256").update(canonicalPath(gitCommonDir)).digest("hex").slice(0, 24);
}

export function getRuntimeRoot(env = process.env) {
  return resolve(env.CODEX_CONCURRENCY_HOME || join(tmpdir(), "codex-concurrency"));
}

export function getGitCommonDir(cwd = process.cwd()) {
  const raw = execFileSync("git", ["rev-parse", "--git-common-dir"], { cwd, encoding: "utf8" }).trim();
  const absolute = resolve(cwd, raw);
  try {
    return realpathSync(absolute);
  } catch {
    return absolute;
  }
}

export function getRepositoryPaths(gitCommonDir, runtimeRoot = getRuntimeRoot()) {
  const repoDir = join(runtimeRoot, "repositories", repositoryId(gitCommonDir));
  return {
    runtimeRoot,
    repoDir,
    stateFile: join(repoDir, "state.json"),
    lockDir: join(repoDir, "state.lock"),
    lifecycleDir: join(repoDir, "lifecycle"),
    metadataFile: join(repoDir, "repository.json"),
  };
}

export function lifecycleFile(paths, provider, sessionId) {
  const id = createHash("sha256").update(`${provider}:${sessionId}`).digest("hex").slice(0, 32);
  return join(paths.lifecycleDir, `${id}.json`);
}

function readJson(file, fallback = null) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  const temp = `${file}.tmp-${process.pid}-${randomUUID()}`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(temp, file);
}

export function loadState(file) {
  return normalizeState(readJson(file, createEmptyState()));
}

export function saveState(file, state) {
  writeJsonAtomic(file, normalizeState(state));
}

function pidIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function lockIsRecoverable(lockDir) {
  const owner = readJson(join(lockDir, "owner.json"), null);
  if (!owner) return true;
  if (owner.hostname !== hostname()) return false;
  return !pidIsAlive(owner.pid);
}

export async function withDirectoryLock(lockDir, callback, options = {}) {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const pollMs = options.pollMs ?? 25;
  const deadline = Date.now() + timeoutMs;
  const token = randomUUID();
  const candidateDir = `${lockDir}.candidate-${process.pid}-${token}`;
  mkdirSync(dirname(lockDir), { recursive: true });
  while (true) {
    try {
      mkdirSync(candidateDir);
      writeFileSync(
        join(candidateDir, "owner.json"),
        JSON.stringify({ token, pid: process.pid, hostname: hostname(), createdAt: new Date().toISOString() }),
      );
      renameSync(candidateDir, lockDir);
      break;
    } catch (error) {
      try {
        rmSync(candidateDir, { recursive: true });
      } catch (cleanupError) {
        if (cleanupError?.code !== "ENOENT") throw cleanupError;
      }
      if (!["EEXIST", "EACCES", "EPERM"].includes(error?.code)) throw error;
      if (lockIsRecoverable(lockDir)) {
        try {
          rmSync(lockDir, { recursive: true });
          continue;
        } catch (removeError) {
          if (removeError?.code !== "ENOENT") throw removeError;
        }
      }
      if (Date.now() >= deadline) throw new Error(`state lock timed out: ${lockDir}`);
      await sleep(pollMs);
    }
  }
  try {
    return await callback();
  } finally {
    try {
      if (readJson(join(lockDir, "owner.json"), null)?.token === token) rmSync(lockDir, { recursive: true });
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
}

function getCurrentBranch(cwd = process.cwd()) {
  const result = spawnSync("git", ["branch", "--show-current"], { cwd, encoding: "utf8" });
  return result.status === 0 ? (result.stdout ?? "").trim() : "";
}

function normalizeLifecycle(value) {
  if (!value || typeof value !== "object") return null;
  if (!value.provider || !value.sessionId) return null;
  return {
    version: 1,
    provider: value.provider,
    sessionId: value.sessionId,
    turnId: typeof value.turnId === "string" ? value.turnId : "",
    status: typeof value.status === "string" ? value.status : "idle",
    transcriptPath: typeof value.transcriptPath === "string" ? value.transcriptPath : "",
    cwd: typeof value.cwd === "string" ? value.cwd : "",
    startedAt: typeof value.startedAt === "string" ? value.startedAt : "",
    completedAt: typeof value.completedAt === "string" ? value.completedAt : "",
    transcriptOffset: Number.isSafeInteger(value.transcriptOffset) ? value.transcriptOffset : 0,
    processFingerprint: value.processFingerprint && typeof value.processFingerprint === "object" ? value.processFingerprint : null,
    completionReason: typeof value.completionReason === "string" ? value.completionReason : "",
  };
}

export function readLifecycle(paths, provider, sessionId) {
  return normalizeLifecycle(readJson(lifecycleFile(paths, provider, sessionId), null));
}

export function writeLifecycle(paths, lifecycle) {
  mkdirSync(paths.lifecycleDir, { recursive: true });
  writeJsonAtomic(lifecycleFile(paths, lifecycle.provider, lifecycle.sessionId), lifecycle);
}

function transcriptSize(file) {
  try {
    return statSync(file).size;
  } catch {
    return 0;
  }
}

function contentTexts(content) {
  if (typeof content === "string") return [content];
  if (!Array.isArray(content)) return [];
  return content.flatMap((item) => {
    if (typeof item === "string") return [item];
    if (typeof item?.text === "string") return [item.text];
    if (typeof item?.content === "string") return [item.content];
    return [];
  });
}

export function isClaudeInterruptEvent(event) {
  if (event?.type !== "user" || event?.isSidechain === true) return false;
  return contentTexts(event?.message?.content).some((text) => /^\s*\[?(?:Request )?interrupted by user(?:[^\]]*)?\]?\s*$/i.test(text));
}

export function readJsonlEvents(file, offset = 0) {
  if (!file || !existsSync(file)) return [];
  let text;
  try {
    const buffer = readFileSync(file);
    text = buffer.subarray(Math.min(offset, buffer.length)).toString("utf8");
  } catch {
    return [];
  }
  return text.split(/\r?\n/).filter(Boolean).flatMap((line) => {
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  });
}

export function codexTurnIsActive(events, turnId) {
  if (!turnId) return false;
  let sawTurn = false;
  for (const event of events) {
    const startedTurn =
      event?.type === "turn_context" ? event?.payload?.turn_id : event?.type === "event_msg" && event?.payload?.type === "task_started" ? event?.payload?.turn_id : "";
    if (startedTurn) {
      if (startedTurn === turnId) sawTurn = true;
      else if (sawTurn) return false;
    }
    if (event?.type === "event_msg" && event?.payload?.type === "task_complete" && event?.payload?.turn_id === turnId) return false;
  }
  return sawTurn;
}

export function ownerIsActiveFromLifecycle(owner, lifecycle, transcriptEvents = []) {
  if (!lifecycle || lifecycle.provider !== owner.provider || lifecycle.sessionId !== owner.sessionId) return false;
  if (lifecycle.turnId !== owner.turnId) return false;
  if (lifecycle.status === "completed" || lifecycle.status === "failed" || lifecycle.status === "ended" || lifecycle.status === "superseded") return false;
  if (owner.provider === "claude" && transcriptEvents.some(isClaudeInterruptEvent)) return false;
  if (owner.provider === "claude" && owner.processFingerprint && !processFingerprintIsAlive(owner.processFingerprint)) return false;
  if (owner.provider === "codex" && owner.transcriptPath && !codexTurnIsActive(transcriptEvents, owner.turnId)) return false;
  return lifecycle.status === "active" || lifecycle.status === "paused";
}

export function ownerIsActive(paths, owner) {
  const lifecycle = readLifecycle(paths, owner.provider, owner.sessionId);
  const offset = owner.provider === "claude" && lifecycle?.turnId === owner.turnId ? lifecycle.transcriptOffset : 0;
  const events = readJsonlEvents(owner.transcriptPath || lifecycle?.transcriptPath || "", offset);
  return ownerIsActiveFromLifecycle(owner, lifecycle, events);
}

export async function pruneState(paths, state = loadState(paths.stateFile)) {
  const activity = new Map();
  const isActive = (owner) => {
    const key = `${owner.provider}:${owner.sessionId}:${owner.turnId}`;
    if (!activity.has(key)) activity.set(key, ownerIsActive(paths, owner));
    return activity.get(key);
  };
  return pruneInactiveGateRecords(state, isActive);
}

function detectProvider(env = process.env) {
  if (env.CODEX_CONCURRENCY_PROVIDER === "claude" || env.CODEX_CONCURRENCY_PROVIDER === "codex") return env.CODEX_CONCURRENCY_PROVIDER;
  if (env.CODEX_THREAD_ID) return "codex";
  return "";
}

function detectSessionId(provider, env = process.env) {
  if (env.CODEX_CONCURRENCY_SESSION_ID) return env.CODEX_CONCURRENCY_SESSION_ID;
  if (provider === "codex") return env.CODEX_THREAD_ID ?? "";
  return "";
}

export function getClaimant(paths, label = "", env = process.env, cwd = process.cwd()) {
  const provider = detectProvider(env);
  const sessionId = detectSessionId(provider, env);
  if (!provider || !sessionId) throw new Error("active Codex/Claude session could not be identified; run codex-concurrency setup and doctor");
  const lifecycle = readLifecycle(paths, provider, sessionId);
  if (!lifecycle || !["active", "paused"].includes(lifecycle.status) || !lifecycle.turnId) {
    throw new Error(`active ${provider} turn is not registered; verify lifecycle hooks with codex-concurrency doctor`);
  }
  return {
    provider,
    sessionId,
    turnId: lifecycle.turnId,
    transcriptPath: lifecycle.transcriptPath,
    processFingerprint: lifecycle.processFingerprint,
    cwd,
    branch: getCurrentBranch(cwd),
    label,
    claimedAt: new Date().toISOString(),
  };
}

export async function claim(paths, resources, claimant) {
  return withDirectoryLock(paths.lockDir, async () => {
    const loaded = loadState(paths.stateFile);
    const { state: pruned } = await pruneState(paths, loaded);
    const result = claimResources(pruned, resources, claimant, (owner) => ownerIsActive(paths, owner));
    if (result.status !== "blocked") saveState(paths.stateFile, result.state);
    else if (JSON.stringify(pruned) !== JSON.stringify(loaded)) saveState(paths.stateFile, pruned);
    return result;
  });
}

export async function status(paths, resources = []) {
  return withDirectoryLock(paths.lockDir, async () => {
    const loaded = loadState(paths.stateFile);
    const { state, changed } = await pruneState(paths, loaded);
    if (changed) saveState(paths.stateFile, state);
    const names = normalizeResourceNames(resources);
    const gates = names.length > 0 ? Object.fromEntries(names.map((name) => [name, state.gates[name] ?? null])) : state.gates;
    return { gates };
  });
}

async function releaseOwnedGates(paths, provider, sessionId, turnId = "") {
  return withDirectoryLock(paths.lockDir, async () => {
    const state = loadState(paths.stateFile);
    let changed = false;
    for (const [resource, owner] of Object.entries(state.gates)) {
      if (owner.provider === provider && owner.sessionId === sessionId && (!turnId || owner.turnId === turnId)) {
        delete state.gates[resource];
        changed = true;
      }
    }
    if (changed) {
      state.updatedAt = new Date().toISOString();
      saveState(paths.stateFile, state);
    }
    return changed;
  });
}

function processDetails(pid) {
  try {
    if (platform() === "win32") {
      const script = [
        `$process = Get-Process -Id ${pid} -ErrorAction Stop`,
        `$command = (Get-CimInstance Win32_Process -Filter \"ProcessId = ${pid}\" -ErrorAction SilentlyContinue).CommandLine`,
        `[PSCustomObject]@{ startedAt = $process.StartTime.ToUniversalTime().ToString('o'); command = $command } | ConvertTo-Json -Compress`,
      ].join("; ");
      return JSON.parse(execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8" }).trim());
    }
    const startedAt = execFileSync("ps", ["-p", String(pid), "-o", "lstart="], { encoding: "utf8" }).trim();
    const command = execFileSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8" }).trim();
    return { startedAt, command };
  } catch {
    return { startedAt: "", command: "" };
  }
}

function processFingerprint() {
  const details = processDetails(process.ppid);
  return {
    pid: process.ppid,
    hostname: hostname(),
    startedAt: details.startedAt,
    trustedHost: /(?:^|[\\/])claude(?:\.exe)?(?:\s|$)|@anthropic-ai[\\/]claude-code|claude-code/i.test(details.command),
    observedAt: new Date().toISOString(),
  };
}

function processFingerprintIsAlive(fingerprint) {
  if (!fingerprint?.trustedHost) return true;
  if (fingerprint.hostname !== hostname() || !pidIsAlive(fingerprint.pid)) return false;
  if (!fingerprint.startedAt) return true;
  return processDetails(fingerprint.pid).startedAt === fingerprint.startedAt;
}

function eventTurnId(provider, input) {
  if (provider === "codex") return typeof input.turn_id === "string" ? input.turn_id : "";
  return typeof input.prompt_id === "string" && input.prompt_id ? input.prompt_id : randomUUID();
}

function appendClaudeEnvironment(input) {
  const envFile = process.env.CLAUDE_ENV_FILE;
  if (!envFile) return;
  const lines = [
    "export CODEX_CONCURRENCY_PROVIDER=claude",
    `export CODEX_CONCURRENCY_SESSION_ID=${JSON.stringify(input.session_id)}`,
  ];
  appendFileSync(envFile, `${lines.join("\n")}\n`, "utf8");
}

export async function handleHookEvent(provider, input, options = {}) {
  if (provider !== "codex" && provider !== "claude") throw new Error(`unsupported hook provider: ${provider}`);
  const sessionId = typeof input?.session_id === "string" ? input.session_id : "";
  const cwd = typeof input?.cwd === "string" && input.cwd ? input.cwd : options.cwd ?? process.cwd();
  if (!sessionId) throw new Error("hook input is missing session_id");
  const gitCommonDir = options.gitCommonDir ?? getGitCommonDir(cwd);
  const paths = options.paths ?? getRepositoryPaths(gitCommonDir, options.runtimeRoot);
  mkdirSync(paths.repoDir, { recursive: true });
  const event = input.hook_event_name;

  if (provider === "claude" && event === "SessionStart") {
    appendClaudeEnvironment(input);
    const previous = readLifecycle(paths, provider, sessionId);
    writeLifecycle(paths, {
      version: 1,
      provider,
      sessionId,
      turnId: previous?.turnId ?? "",
      status: previous?.status ?? "idle",
      transcriptPath: input.transcript_path ?? previous?.transcriptPath ?? "",
      cwd,
      startedAt: previous?.startedAt ?? "",
      completedAt: previous?.completedAt ?? "",
      transcriptOffset: previous?.transcriptOffset ?? 0,
      processFingerprint: processFingerprint(),
      completionReason: previous?.completionReason ?? "",
    });
    return { status: "session-registered" };
  }

  if (event === "UserPromptSubmit") {
    const previous = readLifecycle(paths, provider, sessionId);
    if (previous?.turnId && previous.status !== "completed") await releaseOwnedGates(paths, provider, sessionId, previous.turnId);
    const transcriptPath = input.transcript_path ?? previous?.transcriptPath ?? "";
    const lifecycle = {
      version: 1,
      provider,
      sessionId,
      turnId: eventTurnId(provider, input),
      status: "active",
      transcriptPath,
      cwd,
      startedAt: new Date().toISOString(),
      completedAt: "",
      transcriptOffset: transcriptSize(transcriptPath),
      processFingerprint: processFingerprint(),
      completionReason: "",
    };
    writeLifecycle(paths, lifecycle);
    return { status: "turn-started", turnId: lifecycle.turnId };
  }

  const previous = readLifecycle(paths, provider, sessionId);
  if (!previous) return { status: "ignored", reason: "session-not-registered" };

  if (provider === "claude" && event === "Stop") {
    const background = Array.isArray(input.background_tasks) ? input.background_tasks : [];
    const crons = Array.isArray(input.session_crons) ? input.session_crons : [];
    if (background.length > 0 || crons.length > 0) {
      writeLifecycle(paths, { ...previous, status: "paused", completionReason: "background-work" });
      return { status: "retained", backgroundTasks: background.length, sessionCrons: crons.length };
    }
  }

  if (["Stop", "StopFailure", "SessionEnd"].includes(event)) {
    const turnId = provider === "codex" && input.turn_id ? input.turn_id : previous.turnId;
    await releaseOwnedGates(paths, provider, sessionId, event === "SessionEnd" ? "" : turnId);
    writeLifecycle(paths, {
      ...previous,
      turnId,
      status: event === "StopFailure" ? "failed" : event === "SessionEnd" ? "ended" : "completed",
      completedAt: new Date().toISOString(),
      completionReason: event,
    });
    return { status: "released", reason: event };
  }

  return { status: "ignored", reason: `unsupported-event:${event}` };
}

function hookCommand(provider, executablePath, os = platform()) {
  const escaped = executablePath.replaceAll('"', '\\"');
  if (os === "win32") return `node \"${escaped}\" hook ${provider}`;
  return `node ${JSON.stringify(executablePath)} hook ${provider}`;
}

function hookHandler(provider, executablePath) {
  if (provider === "claude") {
    return {
      type: "command",
      command: process.execPath,
      args: [executablePath, "hook", provider],
      timeout: 30,
      statusMessage: "Updating concurrency ownership",
    };
  }
  return { type: "command", command: hookCommand(provider, executablePath), timeout: 30, statusMessage: "Updating concurrency ownership" };
}

function isManagedHook(hook, provider) {
  return (
    (typeof hook?.command === "string" && hook.command.includes(` hook ${provider}`)) ||
    (Array.isArray(hook?.args) && hook.args.length >= 2 && hook.args.at(-2) === "hook" && hook.args.at(-1) === provider)
  );
}

export function mergeHookConfig(existing, provider, executablePath) {
  const next = existing && typeof existing === "object" && !Array.isArray(existing) ? structuredClone(existing) : {};
  next.hooks = next.hooks && typeof next.hooks === "object" && !Array.isArray(next.hooks) ? next.hooks : {};
  const events = provider === "codex" ? ["UserPromptSubmit", "Stop"] : ["SessionStart", "UserPromptSubmit", "Stop", "StopFailure", "SessionEnd"];
  for (const event of events) {
    const groups = Array.isArray(next.hooks[event]) ? next.hooks[event] : [];
    const filtered = groups.filter(
      (group) => !Array.isArray(group?.hooks) || !group.hooks.some((hook) => isManagedHook(hook, provider)),
    );
    filtered.push({ hooks: [hookHandler(provider, executablePath)] });
    next.hooks[event] = filtered;
  }
  return next;
}

export function setupTargets(home = homedir()) {
  return {
    codex: join(home, ".codex", "hooks.json"),
    claude: join(home, ".claude", "settings.json"),
  };
}

export function setupHooks({ host = "all", dryRun = false, home = homedir(), executablePath }) {
  if (!["all", "codex", "claude"].includes(host)) throw new Error(`invalid setup host: ${host}`);
  const targets = setupTargets(home);
  const providers = host === "all" ? ["codex", "claude"] : [host];
  const results = [];
  for (const provider of providers) {
    const file = targets[provider];
    let existing = {};
    if (existsSync(file)) {
      try {
        existing = JSON.parse(readFileSync(file, "utf8"));
      } catch (error) {
        throw new Error(`cannot update malformed ${provider} settings: ${file}: ${error.message}`);
      }
    }
    const merged = mergeHookConfig(existing, provider, executablePath);
    const changed = JSON.stringify(existing) !== JSON.stringify(merged);
    if (!dryRun && changed) writeJsonAtomic(file, merged);
    results.push({ provider, file, changed, dryRun });
  }
  return results;
}

export function commandVersion(command, { systemPlatform = platform(), spawn = spawnSync } = {}) {
  const executable = systemPlatform === "win32" ? process.env.ComSpec || "cmd.exe" : command;
  const args = systemPlatform === "win32" ? ["/d", "/s", "/c", `${command} --version`] : ["--version"];
  const result = spawn(executable, args, { encoding: "utf8" });
  return result.status === 0 ? (result.stdout || result.stderr || "").trim() : "unavailable";
}

export function versionAtLeast(text, minimum) {
  const match = String(text).match(/(\d+)\.(\d+)\.(\d+)/);
  if (!match) return false;
  const actual = match.slice(1).map(Number);
  const expected = minimum.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (actual[index] > expected[index]) return true;
    if (actual[index] < expected[index]) return false;
  }
  return true;
}

function hasManagedHook(file, provider) {
  const config = readJson(file, {});
  const required = provider === "codex" ? ["UserPromptSubmit", "Stop"] : ["SessionStart", "UserPromptSubmit", "Stop", "StopFailure", "SessionEnd"];
  return required.every(
    (event) =>
      Array.isArray(config?.hooks?.[event]) &&
      config.hooks[event].some(
        (group) => Array.isArray(group?.hooks) && group.hooks.some((hook) => isManagedHook(hook, provider)),
      ),
  );
}

export function doctor({ cwd = process.cwd(), home = homedir(), env = process.env } = {}) {
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok, detail });
  add("node", Number(process.versions.node.split(".")[0]) >= 20, process.version);
  add("platform", platform() === "win32" || platform() === "darwin", platform());
  const targets = setupTargets(home);
  add("codex-hooks", hasManagedHook(targets.codex, "codex"), targets.codex);
  add("claude-hooks", hasManagedHook(targets.claude, "claude"), targets.claude);
  const codexVersion = commandVersion("codex");
  const claudeVersion = commandVersion("claude");
  add("codex-version", codexVersion !== "unavailable", codexVersion);
  add("claude-version", versionAtLeast(claudeVersion, "2.1.145"), claudeVersion === "unavailable" ? claudeVersion : `${claudeVersion}; minimum 2.1.145`);
  try {
    const common = getGitCommonDir(cwd);
    const paths = getRepositoryPaths(common, getRuntimeRoot(env));
    mkdirSync(paths.repoDir, { recursive: true });
    const probe = join(paths.repoDir, `.write-probe-${process.pid}`);
    writeFileSync(probe, "ok");
    rmSync(probe);
    add("runtime-state", true, paths.repoDir);
    add("legacy-state", !existsSync(join(common, "codex-concurrency", "state.json")), join(common, "codex-concurrency", "state.json"));
    const provider = detectProvider(env);
    const sessionId = detectSessionId(provider, env);
    const lifecycle = provider && sessionId ? readLifecycle(paths, provider, sessionId) : null;
    add("active-owner", Boolean(lifecycle?.status === "active" && lifecycle?.turnId), lifecycle ? `${provider}:${sessionId}:${lifecycle.status}` : "not inside a registered turn");
    add(
      "codex-hook-trust",
      provider === "codex" && Boolean(lifecycle?.turnId),
      provider === "codex" && lifecycle?.turnId ? "verified by a lifecycle event in this turn" : "unverified; review installed hooks with /hooks",
    );
  } catch (error) {
    add("runtime-state", false, error.message);
  }
  return {
    ok: checks.every((check) => check.ok || ["active-owner", "legacy-state", "codex-hook-trust"].includes(check.name)),
    checks,
  };
}
