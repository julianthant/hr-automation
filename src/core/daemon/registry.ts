import { randomBytes } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import type { Daemon, DaemonLockfile } from './types.js'

/**
 * Absolute path to the repo-local tsx binary. We spawn this directly instead
 * of `npx tsx` so `child.pid` matches the tsx process's pid (and therefore
 * the lockfile pid) — npx inserts an intermediate shell whose pid never
 * matches anything we can discover, which caused `spawnDaemon`'s 5-minute
 * timeout even when the daemon came up cleanly in 2s (pre-2026-04-22 bug).
 */
const TSX_BIN = resolve(process.cwd(), 'node_modules/.bin/tsx')

/**
 * Default on-disk location for daemon lockfiles + queue + log files.
 * Resolvable relative to CWD for normal use; override-able via trackerDir
 * for tests and sandboxed runs.
 */
const DEFAULT_DIR = '.tracker/daemons'

export function daemonsDir(trackerDir?: string): string {
  return trackerDir ? join(trackerDir, 'daemons') : DEFAULT_DIR
}

export function lockfilePath(workflow: string, instanceId: string, trackerDir?: string): string {
  return join(daemonsDir(trackerDir), `${workflow}-${instanceId}.lock.json`)
}

export function ensureDaemonsDir(trackerDir?: string): void {
  mkdirSync(daemonsDir(trackerDir), { recursive: true })
}

/**
 * Generate a short instance id of the form `<prefix>-<hex>`. Prefix is the
 * first three letters of the workflow name (stripped of non-alpha), or "wf"
 * when the workflow name has no alpha chars.
 */
export function randomInstanceId(workflow: string): string {
  const lettersOnly = workflow.toLowerCase().replace(/[^a-z]/g, '')
  const prefix = lettersOnly.length > 0 ? lettersOnly.slice(0, 3) : 'wf'
  return `${prefix}-${randomBytes(2).toString('hex')}`
}

/**
 * Write a lockfile atomically via tmp + rename. Caller is responsible for
 * unlinking on clean shutdown.
 */
export function writeLockfile(lock: DaemonLockfile, path: string): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`
  writeFileSync(tmp, JSON.stringify(lock))
  renameSync(tmp, path)
  invalidateAliveDaemonsCache(lock.workflow)
}

/**
 * Read a lockfile. Returns null on missing-file, malformed-JSON, or
 * schema-mismatch (version !== 1; missing required numeric fields).
 * Never throws — callers treat null as "lockfile invalid, ignore".
 */
export function readLockfile(path: string): DaemonLockfile | null {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return null
  }
  try {
    const parsed = JSON.parse(text) as Partial<DaemonLockfile>
    if (!parsed || typeof parsed !== 'object') return null
    if (parsed.version !== 1) return null
    if (typeof parsed.pid !== 'number' || typeof parsed.port !== 'number') return null
    if (typeof parsed.workflow !== 'string' || typeof parsed.instanceId !== 'string') return null
    if (typeof parsed.startedAt !== 'string' || typeof parsed.hostname !== 'string') return null
    return parsed as DaemonLockfile
  } catch {
    return null
  }
}

export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * Three-state probe so callers can distinguish "definitely stale lockfile"
 * (positive identity mismatch — the port is bound by a different daemon, or
 * by some unrelated process) from "transiently unreachable" (timeout or
 * connection error — daemon's event loop may be momentarily busy). The
 * latter must NOT trigger an unlink: orphaning a healthy daemon causes
 * `enqueueFromHttp` to spawn a duplicate.
 */
type ProbeResult = 'match' | 'mismatch' | 'unreachable'

/**
 * Richer probe outcome that also surfaces the peer's self-reported teardown
 * state (`/whoami.shuttingDown`). Used by the hand-off availability check
 * (E2E-105): a peer that POSITIVELY matches but reports `shuttingDown: true`
 * is responsive yet NOT a valid target to leave queued/in-flight work for —
 * it is itself dying. `shuttingDown` is only meaningful when `result` is
 * `'match'`; it defaults to `false` for legacy daemons whose `/whoami`
 * predates the field.
 */
interface WhoamiProbe {
  result: ProbeResult
  shuttingDown: boolean
}

const ALIVE_DAEMONS_CACHE_TTL_MS = 2_000
const aliveDaemonsCache = new Map<string, { value: Promise<Daemon[]>; expires: number }>()

function aliveDaemonsCacheKey(workflow: string, trackerDir?: string): string {
  return `${trackerDir ?? ''}\u0000${workflow}`
}

export function invalidateAliveDaemonsCache(workflow?: string, trackerDir?: string): void {
  if (!workflow) {
    aliveDaemonsCache.clear()
    return
  }
  if (trackerDir !== undefined) {
    aliveDaemonsCache.delete(aliveDaemonsCacheKey(workflow, trackerDir))
    return
  }
  for (const key of aliveDaemonsCache.keys()) {
    if (key.endsWith(`\u0000${workflow}`)) aliveDaemonsCache.delete(key)
  }
}

async function probeWhoami(
  port: number,
  expected: { workflow: string; instanceId: string },
  timeoutMs = 1500,
): Promise<WhoamiProbe> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/whoami`, {
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!res.ok) return { result: 'unreachable', shuttingDown: false }
    const body = (await res.json()) as {
      workflow?: string
      instanceId?: string
      shuttingDown?: boolean
    }
    if (body.workflow === expected.workflow && body.instanceId === expected.instanceId) {
      return { result: 'match', shuttingDown: body.shuttingDown === true }
    }
    return { result: 'mismatch', shuttingDown: false }
  } catch {
    return { result: 'unreachable', shuttingDown: false }
  }
}

/**
 * Strict liveness check for a SINGLE already-discovered peer daemon: hits its
 * `/whoami` and returns true ONLY when the handshake positively MATCHES the
 * daemon's identity. Unlike `findAliveDaemons` — which deliberately trusts an
 * unreachable-but-PID-alive lockfile (to avoid orphaning a momentarily-busy
 * daemon and spawning a duplicate) — this returns FALSE for `unreachable` /
 * `mismatch`. Use it when a wrong answer is costly: at shutdown, "is there a
 * peer that will ACTUALLY pick up a reassigned item?" must not be satisfied by
 * a wedged/zombie daemon whose PID is alive but whose event loop never wakes
 * to claim work — otherwise the reassigned item sits `queued` forever instead
 * of failing loud.
 */
export async function isDaemonResponsive(daemon: Daemon, timeoutMs = 1500): Promise<boolean> {
  const probe = await probeWhoami(
    daemon.port,
    { workflow: daemon.workflow, instanceId: daemon.instanceId },
    timeoutMs,
  )
  return probe.result === 'match'
}

/**
 * Like `isDaemonResponsive`, but ALSO requires the peer is not itself tearing
 * down: a peer is available to HAND WORK OFF to only if it positively matches
 * `/whoami` AND reports `shuttingDown: false`. This is the E2E-105 gate — on a
 * simultaneous workflow-scoped stop-all, every dying daemon still answers
 * `/whoami` with `match` (its HTTP listener stays up until the very end of
 * teardown), so `isDaemonResponsive` alone would let each daemon leave its
 * queued/in-flight work "for a peer" that is also dying → orphaned `queued`.
 * The dashboard's stop sets `shuttingDown` synchronously in every daemon's
 * `/stop` handler before it responds, so by teardown-sweep time a stopped peer
 * reports `shuttingDown: true` and is correctly excluded here.
 */
export async function isDaemonAvailableForHandoff(
  daemon: Daemon,
  timeoutMs = 1500,
): Promise<boolean> {
  const probe = await probeWhoami(
    daemon.port,
    { workflow: daemon.workflow, instanceId: daemon.instanceId },
    timeoutMs,
  )
  return probe.result === 'match' && !probe.shuttingDown
}

/**
 * Filter a peer set down to daemons that POSITIVELY respond to `/whoami`
 * right now (probed in parallel). Built for the shutdown reassign decision:
 * the candidate must be reachable AND identity-matched, not merely PID-alive.
 */
export async function filterResponsiveDaemons(
  daemons: Daemon[],
  timeoutMs = 1500,
): Promise<Daemon[]> {
  const results = await Promise.all(
    daemons.map(async (d) => ((await isDaemonResponsive(d, timeoutMs)) ? d : null)),
  )
  return results.filter((d): d is Daemon => d !== null)
}

/**
 * Filter a peer set down to daemons that are AVAILABLE FOR HAND-OFF — responsive
 * AND not themselves shutting down (`isDaemonAvailableForHandoff`). This is the
 * authority the teardown sweeps consult to decide "will a peer actually finish
 * the queued/in-flight item I'm about to leave behind?": a stricter check than
 * `filterResponsiveDaemons` because a peer that already received `/stop` is
 * responsive but will NOT pick up new work. Used by both the in-flight reassign
 * decision and the never-claimed-queued sweep so a force teardown that is
 * effectively the last responsive owner terminalizes its queue instead of
 * orphaning it (E2E-105).
 */
export async function filterPeersAvailableForHandoff(
  daemons: Daemon[],
  timeoutMs = 1500,
): Promise<Daemon[]> {
  const results = await Promise.all(
    daemons.map(async (d) => ((await isDaemonAvailableForHandoff(d, timeoutMs)) ? d : null)),
  )
  return results.filter((d): d is Daemon => d !== null)
}

function safeUnlink(path: string): void {
  try {
    unlinkSync(path)
  } catch {
    /* best-effort */
  }
}

/**
 * Discover alive daemons for `workflow`. Walks `.tracker/daemons/` for files
 * matching `${workflow}-*.lock.json`, parses each, verifies the PID is alive,
 * and confirms the `/whoami` handshake matches the lockfile. Dead or invalid
 * lockfiles are unlinked as a side effect so they don't keep getting
 * re-probed. Results are sorted by `startedAt` ascending (oldest first).
 */
export function findAliveDaemons(workflow: string, trackerDir?: string): Promise<Daemon[]> {
  const key = aliveDaemonsCacheKey(workflow, trackerDir)
  const cached = aliveDaemonsCache.get(key)
  const now = Date.now()
  if (cached && cached.expires > now) return cached.value
  const value = findAliveDaemonsUncached(workflow, trackerDir)
  aliveDaemonsCache.set(key, { value, expires: now + ALIVE_DAEMONS_CACHE_TTL_MS })
  return value
}

async function findAliveDaemonsUncached(workflow: string, trackerDir?: string): Promise<Daemon[]> {
  const dir = daemonsDir(trackerDir)
  if (!existsSync(dir)) return []
  const prefix = `${workflow}-`
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return []
  }
  const candidates = entries.filter(
    (f) => f.startsWith(prefix) && f.endsWith('.lock.json') && !f.includes('.lock.json.tmp'),
  )
  // Probe every candidate in parallel — each lockfile + probe is an
  // independent network/syscall pair. Worst-case wall time was N × 1.5s
  // (one slow probe times out, the next one starts); now it's max(per-probe).
  const probeResults = await Promise.all(
    candidates.map(async (entry) => {
      const path = join(dir, entry)
      const lock = readLockfile(path)
      if (!lock || lock.workflow !== workflow) {
        safeUnlink(path)
        return null
      }
      if (!isProcessAlive(lock.pid)) {
        safeUnlink(path)
        return null
      }
      const probe = (await probeWhoami(lock.port, {
        workflow: lock.workflow,
        instanceId: lock.instanceId,
      })).result
      if (probe === 'mismatch') {
        // Positive identity mismatch: that port is bound by a different daemon
        // (or an unrelated process). Lockfile is stale — unlink so subsequent
        // probes don't keep checking it.
        safeUnlink(path)
        return null
      }
      // 'match' OR ('unreachable' && PID alive) — trust the lockfile. The
      // unreachable-but-alive case happens when the daemon's event loop is
      // briefly busy (sync write during keepalive, mid-Playwright RPC). The
      // alternative — unlinking — orphans a healthy daemon and forces enqueue
      // callers to spawn a duplicate. Best-effort wake fan-out tolerates a
      // wedged probe; spawning duplicates is a far worse failure mode.
      return {
        workflow: lock.workflow,
        instanceId: lock.instanceId,
        pid: lock.pid,
        ...(lock.parentPid ? { parentPid: lock.parentPid } : {}),
        port: lock.port,
        startedAt: lock.startedAt,
        lockfilePath: path,
      } satisfies Daemon
    }),
  )
  const alive = probeResults.filter((d): d is Daemon => d !== null)
  alive.sort((a, b) => a.startedAt.localeCompare(b.startedAt))
  return alive
}

/**
 * SYNCHRONOUS, UNCACHED scan of alive-daemon lockfiles for `workflow`,
 * returning the set of `instanceName`s already claimed by live peers.
 *
 * Used by `runWorkflowDaemon` at lockfile-write time to seed
 * `generateInstanceName`'s `reservedNames` so two daemons spawned
 * near-simultaneously never collide on "<wf> 1" (VS-003). The lockfile is the
 * ONLY artifact with a reliable happens-before edge to the next spawn — it is
 * written BEFORE `/whoami` comes up, and `/whoami` is what gates the parent
 * spawning the next daemon — so reading freshly-written peer lockfiles closes
 * the race.
 *
 * Deliberately does NOT use `findAliveDaemons`: that is async, `/whoami`-probes
 * (a peer's listener may not be up yet), has side-effect unlinks, and is
 * CACHED — a stale cache would miss a just-written peer lockfile and reintroduce
 * the race. We only need pid-liveness + the stored name, both readable from the
 * lockfile alone.
 *
 * Dead-pid lockfiles are excluded (a crashed daemon's slot is reusable). Missing
 * dir, readdir errors, malformed lockfiles, and lockfiles without an
 * `instanceName` all degrade to "not reserved".
 */
export function scanAliveDaemonInstanceNames(
  workflow: string,
  trackerDir?: string,
): Set<string> {
  const names = new Set<string>()
  const dir = daemonsDir(trackerDir)
  if (!existsSync(dir)) return names
  const prefix = `${workflow}-`
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return names
  }
  const candidates = entries.filter(
    (f) => f.startsWith(prefix) && f.endsWith('.lock.json') && !f.includes('.lock.json.tmp'),
  )
  for (const entry of candidates) {
    const lock = readLockfile(join(dir, entry))
    if (!lock || lock.workflow !== workflow) continue
    if (!isProcessAlive(lock.pid)) continue
    if (!lock.instanceName) continue
    names.add(lock.instanceName)
  }
  return names
}

const delay = sleep

/**
 * SIGKILL any Chromium processes whose parent process is dead. These are
 * orphaned Playwright-launched Chromium subprocesses left over from a daemon
 * that exited without being able to clean up its browsers (SIGKILL, OOM,
 * crash, force-stop with too-short exit window).
 *
 * Why this matters: the symptom is "8 chrome windows after retry" — when the
 * user retries while a previous daemon's chromium is still running but its
 * tsx parent is gone (`ppid === 1` on Linux/macOS — adopted by init), the
 * new daemon stacks fresh chromium on top of the orphans. Calling this
 * function before each fresh `spawnDaemon` keeps the workspace tidy.
 *
 * Filter: we match Playwright's bundled Chromium via the path
 * `Chromium.app/Contents/MacOS/Chromium` (macOS) or `chrome-linux/chrome`
 * (Linux). User-installed Google Chrome has a different bundle path and
 * is never matched. No Windows handling — pgrep isn't available on win32.
 *
 * Best-effort throughout: a missing pgrep, ps, or process.kill error never
 * throws — returns 0 in those cases. Tests can override the binary discovery
 * via env or by stubbing `execFileSync`.
 *
 * Returns the count of processes successfully sent SIGKILL.
 */
export async function killOrphanedChromiumProcesses(): Promise<number> {
  if (process.platform === 'win32') return 0
  // pgrep -fl matches the full command line; we filter to playwright's
  // bundled chromium binary path (different from Google Chrome). The
  // patterns cover macOS (.app bundle) and Linux (chrome-linux dir).
  const patterns = ['Chromium\\.app/Contents/MacOS/Chromium', 'chrome-linux/chrome']
  const candidates = new Set<number>()
  for (const pat of patterns) {
    try {
      const out = execFileSync('pgrep', ['-f', pat], {
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 2000,
      }).toString()
      for (const line of out.trim().split('\n')) {
        const pid = Number(line.trim())
        if (Number.isFinite(pid) && pid > 0 && pid !== process.pid) candidates.add(pid)
      }
    } catch {
      /* pgrep returns non-zero when no match — treat as no candidates */
    }
  }
  if (candidates.size === 0) return 0
  let killed = 0
  for (const pid of candidates) {
    let ppid: number
    try {
      const out = execFileSync('ps', ['-o', 'ppid=', '-p', String(pid)], {
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 1000,
      }).toString().trim()
      ppid = Number.parseInt(out, 10)
    } catch {
      // Process disappeared between pgrep and ps — already dead, skip.
      continue
    }
    if (!Number.isFinite(ppid) || ppid === null) continue
    // ppid === 1: orphaned (adopted by init).
    // ppid alive: chrome has a live owner (another daemon, a real user
    //   chrome session unrelated to us, etc.) — leave it alone.
    // ppid not alive: race window where the parent died but init hasn't
    //   reaped yet — chrome is dying, kill to be sure.
    const ownerAlive = ppid !== 1 && isProcessAlive(ppid)
    if (ownerAlive) continue
    try {
      process.kill(pid, 'SIGKILL')
      killed++
    } catch {
      /* already gone — race */
    }
  }
  return killed
}

/**
 * Spawn a detached daemon via `tsx src/cli-daemon.ts <workflow>`. Redirects
 * stdout/stderr to a log file in `.tracker/daemons/`. Waits up to 5min for
 * the daemon's lockfile to appear AND the `/whoami` handshake to succeed
 * (auth takes 30s-2min in practice). Throws if the child exits early or
 * the deadline is reached.
 */
export async function spawnDaemon(workflow: string, trackerDir?: string): Promise<Daemon> {
  ensureDaemonsDir(trackerDir)
  const logName = `${workflow}-${new Date().toISOString().replace(/[:.]/g, '-')}.log`
  const logPath = join(daemonsDir(trackerDir), logName)
  const logFd = openSync(logPath, 'a')

  const env = { ...process.env }
  if (trackerDir) env.HRAUTO_TRACKER_DIR = resolve(trackerDir)

  // tsx 4+ re-execs itself with `--import` to mount the loader, so
  // spawn(TSX_BIN, ...) returns the wrapper's pid (e.g. 99304) while the
  // actual daemon code runs in a child node process whose `process.pid` is
  // different (e.g. 99305). Match on EITHER pid OR parentPid so the
  // wrapper's child.pid pairs with the daemon's recorded `process.ppid`.
  // (Pre-2026-05-04 lockfiles lack parentPid; those still match on pid.)
  const child: ChildProcess = spawn(TSX_BIN, ['src/cli-daemon.ts', workflow], {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env,
  })
  child.unref()

  const deadline = Date.now() + 5 * 60 * 1000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(
        `daemon process exited (code ${child.exitCode}) before ready — check ${logPath}`,
      )
    }
    const candidates = await findAliveDaemons(workflow, trackerDir)
    const ours = candidates.find(
      (d) => d.pid === child.pid || d.parentPid === child.pid,
    )
    if (ours) {
      invalidateAliveDaemonsCache(workflow, trackerDir)
      return ours
    }
    await delay(500)
  }
  throw new Error(`daemon failed to start within 5min — check ${logPath}`)
}
