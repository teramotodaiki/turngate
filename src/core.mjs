import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
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
export const HOOK_ID = "turngate-v1";
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
  return resolve(env.TURNGATE_HOME || join(tmpdir(), "turngate"));
}

export function findCodexTranscript(sessionId, { home = homedir(), env = process.env } = {}) {
  if (!/^[A-Za-z0-9-]{1,128}$/.test(sessionId ?? "")) return "";
  const codexHome = resolve(env.CODEX_HOME || join(home, ".codex"));
  const sessionsRoot = join(codexHome, "sessions");
  const suffix = `-${sessionId}.jsonl`.toLowerCase();
  const pending = [sessionsRoot];
  let newest = null;
  while (pending.length > 0) {
    const directory = pending.pop();
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith(suffix)) {
        try {
          const modifiedAt = statSync(path).mtimeMs;
          if (!newest || modifiedAt > newest.modifiedAt) newest = { path, modifiedAt };
        } catch {
          // Ignore files that disappear while sessions are being rotated.
        }
      }
    }
  }
  return newest?.path ?? "";
}

export function getGitCommonDir(cwd = process.cwd()) {
  let raw;
  try {
    raw = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd, encoding: "utf8" }).trim();
  } catch {
    raw = execFileSync("git", ["rev-parse", "--git-common-dir"], { cwd, encoding: "utf8" }).trim();
  }
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

export function hookObservationFile(runtimeRoot, provider, sessionId) {
  const id = createHash("sha256").update(`${provider}:${sessionId}`).digest("hex").slice(0, 32);
  return join(runtimeRoot, "hook-observations", `${id}.json`);
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
  if (!owner) return false;
  if (owner.hostname !== hostname()) return false;
  return !pidIsAlive(owner.pid);
}

async function renameOwnedLock(lockDir, destination, token, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    if (readJson(join(lockDir, "owner.json"), null)?.token !== token) return false;
    try {
      renameSync(lockDir, destination);
      return true;
    } catch (error) {
      if (error?.code === "ENOENT") return false;
      if (!["EACCES", "EPERM"].includes(error?.code) || Date.now() >= deadline) throw error;
      await sleep(10);
    }
  }
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
        const staleDir = `${lockDir}.stale-${process.pid}-${randomUUID()}`;
        try {
          renameSync(lockDir, staleDir);
          rmSync(staleDir, { recursive: true });
          continue;
        } catch (removeError) {
          try {
            rmSync(staleDir, { recursive: true });
          } catch (cleanupError) {
            if (cleanupError?.code !== "ENOENT") throw cleanupError;
          }
          if (!["ENOENT", "EEXIST", "EACCES", "EPERM"].includes(removeError?.code)) throw removeError;
        }
      }
      if (Date.now() >= deadline) throw new Error(`state lock timed out: ${lockDir}`);
      await sleep(pollMs);
    }
  }
  try {
    return await callback();
  } finally {
    const releaseDir = `${lockDir}.release-${process.pid}-${token}`;
    try {
      if (await renameOwnedLock(lockDir, releaseDir, token)) {
        rmSync(releaseDir, { recursive: true });
      }
    } catch (error) {
      try {
        rmSync(releaseDir, { recursive: true });
      } catch (cleanupError) {
        if (cleanupError?.code !== "ENOENT") throw cleanupError;
      }
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

function normalizeHookObservation(value) {
  if (!value || typeof value !== "object" || !value.provider || !value.sessionId) return null;
  return {
    version: 1,
    provider: value.provider,
    sessionId: value.sessionId,
    turnId: typeof value.turnId === "string" ? value.turnId : "",
    event: typeof value.event === "string" ? value.event : "",
    status: typeof value.status === "string" ? value.status : "unknown",
    resultStatus: typeof value.resultStatus === "string" ? value.resultStatus : "",
    error: typeof value.error === "string" ? value.error : "",
    cwd: typeof value.cwd === "string" ? value.cwd : "",
    observedAt: typeof value.observedAt === "string" ? value.observedAt : "",
  };
}

export function readHookObservation(runtimeRoot, provider, sessionId) {
  return normalizeHookObservation(readJson(hookObservationFile(runtimeRoot, provider, sessionId), null));
}

function writeHookObservation(runtimeRoot, observation) {
  writeJsonAtomic(hookObservationFile(runtimeRoot, observation.provider, observation.sessionId), observation);
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

export function readCodexTurnEvents(file) {
  if (!file || !existsSync(file)) return [];
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  return text.split(/\r?\n/).filter(Boolean).flatMap((line) => {
    try {
      const event = JSON.parse(line);
      if (event?.type === "turn_context" && typeof event?.payload?.turn_id === "string") {
        return [{ type: "turn_context", payload: { turn_id: event.payload.turn_id } }];
      }
      if (
        event?.type === "event_msg" &&
        ["task_started", "task_complete"].includes(event?.payload?.type) &&
        typeof event?.payload?.turn_id === "string"
      ) {
        return [{ type: "event_msg", payload: { type: event.payload.type, turn_id: event.payload.turn_id } }];
      }
      return [];
    } catch {
      return [];
    }
  });
}

export function activeCodexTurnId(events) {
  let activeTurnId = "";
  for (const event of events) {
    const startedTurn =
      event?.type === "turn_context" ? event?.payload?.turn_id : event?.type === "event_msg" && event?.payload?.type === "task_started" ? event?.payload?.turn_id : "";
    if (startedTurn) activeTurnId = startedTurn;
    if (event?.type === "event_msg" && event?.payload?.type === "task_complete" && event?.payload?.turn_id === activeTurnId) activeTurnId = "";
  }
  return activeTurnId;
}

export function codexTurnIsActive(events, turnId) {
  return Boolean(turnId) && activeCodexTurnId(events) === turnId;
}

function lifecycleWithTranscriptTurn(lifecycle, transcriptEvents) {
  if (lifecycle?.provider !== "codex" || !lifecycle.transcriptPath) return lifecycle;
  const transcriptTurnId = activeCodexTurnId(transcriptEvents);
  if (!transcriptTurnId || transcriptTurnId === lifecycle.turnId) return lifecycle;
  return {
    ...lifecycle,
    turnId: transcriptTurnId,
    status: "active",
    completedAt: "",
    completionReason: "transcript-continuation",
  };
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
  const storedLifecycle = readLifecycle(paths, owner.provider, owner.sessionId);
  const fallbackLifecycle =
    !storedLifecycle && owner.provider === "codex" && owner.transcriptPath
      ? {
          version: 1,
          provider: owner.provider,
          sessionId: owner.sessionId,
          turnId: owner.turnId,
          status: "active",
          transcriptPath: owner.transcriptPath,
          processFingerprint: null,
        }
      : null;
  const baseLifecycle = storedLifecycle ?? fallbackLifecycle;
  const offset = owner.provider === "claude" && baseLifecycle?.turnId === owner.turnId ? baseLifecycle.transcriptOffset : 0;
  const transcriptPath = owner.transcriptPath || baseLifecycle?.transcriptPath || "";
  const events = owner.provider === "codex" ? readCodexTurnEvents(transcriptPath) : readJsonlEvents(transcriptPath, offset);
  const lifecycle = lifecycleWithTranscriptTurn(baseLifecycle, events);
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
  if (env.TURNGATE_PROVIDER === "claude" || env.TURNGATE_PROVIDER === "codex") return env.TURNGATE_PROVIDER;
  if (env.CODEX_THREAD_ID) return "codex";
  return "";
}

function detectSessionId(provider, env = process.env) {
  if (env.TURNGATE_SESSION_ID) return env.TURNGATE_SESSION_ID;
  if (provider === "codex") return env.CODEX_THREAD_ID ?? "";
  return "";
}

function discoverCodexLifecycle(sessionId, { home = homedir(), env = process.env, cwd = process.cwd() } = {}) {
  const transcriptPath = findCodexTranscript(sessionId, { home, env });
  if (!transcriptPath) return null;
  const turnId = activeCodexTurnId(readCodexTurnEvents(transcriptPath));
  if (!turnId) return null;
  return {
    version: 1,
    provider: "codex",
    sessionId,
    turnId,
    status: "active",
    transcriptPath,
    cwd,
    startedAt: "",
    completedAt: "",
    transcriptOffset: 0,
    processFingerprint: null,
    completionReason: "transcript-discovery",
  };
}

function claimableLifecycle(lifecycle) {
  if (!lifecycle || !lifecycle.turnId) return null;
  const transcriptOffset = lifecycle.provider === "claude" ? lifecycle.transcriptOffset : 0;
  const transcriptEvents = lifecycle.transcriptPath
    ? lifecycle.provider === "codex"
      ? readCodexTurnEvents(lifecycle.transcriptPath)
      : readJsonlEvents(lifecycle.transcriptPath, transcriptOffset)
    : [];
  const effectiveLifecycle = lifecycleWithTranscriptTurn(lifecycle, transcriptEvents);
  if (!effectiveLifecycle || !["active", "paused"].includes(effectiveLifecycle.status) || !effectiveLifecycle.turnId) return null;
  const lifecycleOwner = {
    provider: effectiveLifecycle.provider,
    sessionId: effectiveLifecycle.sessionId,
    turnId: effectiveLifecycle.turnId,
    transcriptPath: effectiveLifecycle.transcriptPath,
    processFingerprint: effectiveLifecycle.processFingerprint,
  };
  return ownerIsActiveFromLifecycle(lifecycleOwner, effectiveLifecycle, transcriptEvents) ? effectiveLifecycle : null;
}

export function getClaimant(paths, label = "", env = process.env, cwd = process.cwd()) {
  const provider = detectProvider(env);
  const sessionId = detectSessionId(provider, env);
  if (!provider || !sessionId) throw new Error("active Codex/Claude session could not be identified; run turngate setup and doctor");
  const storedLifecycle = readLifecycle(paths, provider, sessionId);
  const discoveredLifecycle = !storedLifecycle && provider === "codex" ? discoverCodexLifecycle(sessionId, { env, cwd }) : null;
  const lifecycle = claimableLifecycle(storedLifecycle ?? discoveredLifecycle);
  if (!lifecycle) {
    throw new Error(`active ${provider} turn is not registered; verify lifecycle hooks with turngate doctor`);
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
    "export TURNGATE_PROVIDER=claude",
    `export TURNGATE_SESSION_ID=${JSON.stringify(input.session_id)}`,
  ];
  appendFileSync(envFile, `${lines.join("\n")}\n`, "utf8");
}

async function handleHookEventInRepository(provider, input, options, context) {
  const { sessionId, cwd, runtimeRoot } = context;
  const gitCommonDir = options.gitCommonDir ?? getGitCommonDir(cwd);
  const paths = options.paths ?? getRepositoryPaths(gitCommonDir, runtimeRoot);
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
    const turnId = eventTurnId(provider, input);
    if (provider === "codex" && !turnId) throw new Error("UserPromptSubmit hook input is missing turn_id");
    const previous = readLifecycle(paths, provider, sessionId);
    if (previous?.turnId && previous.turnId !== turnId) await releaseOwnedGates(paths, provider, sessionId, previous.turnId);
    const transcriptPath = input.transcript_path ?? previous?.transcriptPath ?? "";
    const lifecycle = {
      version: 1,
      provider,
      sessionId,
      turnId,
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

  if (["Stop", "StopFailure", "SessionEnd"].includes(event)) {
    const turnId = provider === "codex" && event !== "SessionEnd" ? (typeof input.turn_id === "string" ? input.turn_id : "") : previous?.turnId ?? "";
    if (provider === "codex" && event !== "SessionEnd" && !turnId) throw new Error(`${event} hook input is missing turn_id`);
    if (provider === "codex" && previous?.turnId && turnId !== previous.turnId) {
      const released = await releaseOwnedGates(paths, provider, sessionId, turnId);
      return { status: released ? "released" : "ignored", reason: "stale-turn", turnId };
    }
    if (!previous) {
      const released = turnId ? await releaseOwnedGates(paths, provider, sessionId, turnId) : false;
      return { status: released ? "released" : "ignored", reason: "session-not-registered" };
    }
  } else if (!previous) {
    return { status: "ignored", reason: "session-not-registered" };
  }

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

export async function handleHookEvent(provider, input, options = {}) {
  if (provider !== "codex" && provider !== "claude") throw new Error(`unsupported hook provider: ${provider}`);
  const sessionId = typeof input?.session_id === "string" ? input.session_id : "";
  const cwd = typeof input?.cwd === "string" && input.cwd ? input.cwd : options.cwd ?? process.cwd();
  if (!sessionId) throw new Error("hook input is missing session_id");
  const runtimeRoot = options.runtimeRoot ?? options.paths?.runtimeRoot ?? getRuntimeRoot();
  const observation = {
    version: 1,
    provider,
    sessionId,
    turnId: eventTurnId(provider, input),
    event: typeof input?.hook_event_name === "string" ? input.hook_event_name : "",
    status: "running",
    resultStatus: "",
    error: "",
    cwd,
    observedAt: new Date().toISOString(),
  };
  writeHookObservation(runtimeRoot, observation);
  try {
    const result = await handleHookEventInRepository(provider, input, options, { sessionId, cwd, runtimeRoot });
    writeHookObservation(runtimeRoot, {
      ...observation,
      status: "succeeded",
      resultStatus: result.status,
      observedAt: new Date().toISOString(),
    });
    return result;
  } catch (error) {
    writeHookObservation(runtimeRoot, {
      ...observation,
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
      observedAt: new Date().toISOString(),
    });
    throw error;
  }
}

function hookCommand(provider, executablePath, nodePath = process.execPath, os = platform()) {
  if (os === "win32") {
    const escapedNode = nodePath.replaceAll('"', '\\"');
    const escapedExecutable = executablePath.replaceAll('"', '\\"');
    return `\"${escapedNode}\" \"${escapedExecutable}\" hook ${provider}`;
  }
  return `${JSON.stringify(nodePath)} ${JSON.stringify(executablePath)} hook ${provider}`;
}

function hookHandler(provider, executablePath, nodePath = process.execPath) {
  if (provider === "claude") {
    return {
      type: "command",
      command: nodePath,
      args: [executablePath, "hook", provider],
      timeout: 30,
      statusMessage: "Updating turngate ownership",
    };
  }
  return { type: "command", command: hookCommand(provider, executablePath, nodePath), timeout: 30, statusMessage: "Updating turngate ownership" };
}

function isManagedHook(hook, provider) {
  const markers = ["turngate", "codex-concurrency"];
  const managedStatus = ["Updating turngate ownership", "Updating concurrency ownership"].includes(hook?.statusMessage);
  const command = typeof hook?.command === "string" ? hook.command.toLowerCase() : "";
  const directExecutable = Array.isArray(hook?.args) && typeof hook.args[0] === "string" ? hook.args[0].toLowerCase() : "";
  const isHookInvocation =
    command.includes(` hook ${provider}`) ||
    (Array.isArray(hook?.args) && hook.args.length >= 2 && hook.args.at(-2) === "hook" && hook.args.at(-1) === provider);
  return isHookInvocation && (managedStatus || markers.some((marker) => command.includes(marker) || directExecutable.includes(marker)));
}

export function mergeHookConfig(existing, provider, executablePath, { nodePath = process.execPath } = {}) {
  const next = existing && typeof existing === "object" && !Array.isArray(existing) ? structuredClone(existing) : {};
  next.hooks = next.hooks && typeof next.hooks === "object" && !Array.isArray(next.hooks) ? next.hooks : {};
  const events = provider === "codex" ? ["UserPromptSubmit", "Stop"] : ["SessionStart", "UserPromptSubmit", "Stop", "StopFailure", "SessionEnd"];
  for (const event of events) {
    const groups = Array.isArray(next.hooks[event]) ? next.hooks[event] : [];
    const filtered = groups.filter(
      (group) => !Array.isArray(group?.hooks) || !group.hooks.some((hook) => isManagedHook(hook, provider)),
    );
    filtered.push({ hooks: [hookHandler(provider, executablePath, nodePath)] });
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

export function setupHooks({ host = "all", dryRun = false, home = homedir(), executablePath, nodePath = process.execPath }) {
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
    const merged = mergeHookConfig(existing, provider, executablePath, { nodePath });
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
  const provider = detectProvider(env);
  const sessionId = detectSessionId(provider, env);
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
    const storedLifecycle = provider && sessionId ? readLifecycle(paths, provider, sessionId) : null;
    const discoveredLifecycle = !storedLifecycle && provider === "codex" && sessionId ? discoverCodexLifecycle(sessionId, { home, env, cwd }) : null;
    const lifecycle = claimableLifecycle(storedLifecycle ?? discoveredLifecycle);
    const activeOwner = Boolean(lifecycle);
    add(
      "active-owner",
      activeOwner,
      lifecycle
        ? `${provider}:${sessionId}:${lifecycle.status}:turn=${lifecycle.turnId || "missing"}${!storedLifecycle ? ":source=transcript-discovery" : storedLifecycle.turnId !== lifecycle.turnId ? ":source=transcript" : ""}`
        : storedLifecycle
          ? `${provider}:${sessionId}:${storedLifecycle.status}:turn=${storedLifecycle.turnId || "missing"}`
        : provider && sessionId
          ? `${provider}:${sessionId}:not-registered`
          : "not inside a registered turn",
    );
    const observation = provider === "codex" && sessionId ? readHookObservation(paths.runtimeRoot, provider, sessionId) : null;
    add(
      "codex-hook-observed",
      provider === "codex" && observation?.status === "succeeded",
      provider !== "codex" || !sessionId
        ? "not observed; not inside a Codex session"
        : !observation
          ? "not observed; review hooks with /hooks, then submit a new prompt"
          : observation.status === "failed"
            ? `last ${observation.event || "unknown"} hook failed: ${observation.error || "unknown error"}`
            : `last ${observation.event || "unknown"} hook ${observation.status}:turn=${observation.turnId || "missing"}:result=${observation.resultStatus || "none"}`,
    );
  } catch (error) {
    add("runtime-state", false, error.message);
  }
  const optionalChecks = new Set(["legacy-state"]);
  if (!provider || !sessionId) optionalChecks.add("active-owner");
  if (provider !== "codex" || !sessionId) optionalChecks.add("codex-hook-observed");
  return {
    ok: checks.every((check) => check.ok || optionalChecks.has(check.name)),
    checks,
  };
}
