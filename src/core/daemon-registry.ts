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
import { hostname } from 'node:os'
import { join, resolve } from 'node:path'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import type { Daemon, DaemonLockfile } from './daemon-types.js'

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
  const dir = path.slice(0, path.lastIndexOf('/'))
  if (dir) mkdirSync(dir, { recursive: true })
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`
  writeFileSync(tmp, JSON.stringify(lock))
  renameSync(tmp, path)
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

async function probeWhoami(
  port: number,
  expected: { workflow: string; instanceId: string },
  timeoutMs = 1500,
): Promise<ProbeResult> {
  try {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), timeoutMs)
    const res = await fetch(`http://127.0.0.1:${port}/whoami`, { signal: ctrl.signal })
    clearTimeout(t)
    if (!res.ok) return 'unreachable'
    const body = (await res.json()) as { workflow?: string; instanceId?: string }
    if (body.workflow === expected.workflow && body.instanceId === expected.instanceId) {
      return 'match'
    }
    return 'mismatch'
  } catch {
    return 'unreachable'
  }
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
export async function findAliveDaemons(workflow: string, trackerDir?: string): Promise<Daemon[]> {
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
  const alive: Daemon[] = []
  for (const entry of candidates) {
    const path = join(dir, entry)
    const lock = readLockfile(path)
    if (!lock || lock.workflow !== workflow) {
      safeUnlink(path)
      continue
    }
    if (!isProcessAlive(lock.pid)) {
      safeUnlink(path)
      continue
    }
    const probe = await probeWhoami(lock.port, {
      workflow: lock.workflow,
      instanceId: lock.instanceId,
    })
    if (probe === 'mismatch') {
      // Positive identity mismatch: that port is bound by a different daemon
      // (or an unrelated process). Lockfile is stale — unlink so subsequent
      // probes don't keep checking it.
      safeUnlink(path)
      continue
    }
    // 'match' OR ('unreachable' && PID alive) — trust the lockfile. The
    // unreachable-but-alive case happens when the daemon's event loop is
    // briefly busy (sync write during keepalive, mid-Playwright RPC). The
    // alternative — unlinking — orphans a healthy daemon and forces enqueue
    // callers to spawn a duplicate. Best-effort wake fan-out tolerates a
    // wedged probe; spawning duplicates is a far worse failure mode.
    alive.push({
      workflow: lock.workflow,
      instanceId: lock.instanceId,
      pid: lock.pid,
      port: lock.port,
      startedAt: lock.startedAt,
      lockfilePath: path,
    })
  }
  alive.sort((a, b) => a.startedAt.localeCompare(b.startedAt))
  return alive
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

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
    let ppid: number | null = null
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

  // Spawn tsx directly (not via `npx tsx`) so child.pid matches the daemon
  // process's pid. npx wraps tsx in a shell, so `child.pid` would be the
  // shell's pid — which never matches the lockfile and would make the
  // findAliveDaemons match below time out after 5 minutes.
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
    const ours = candidates.find((d) => d.pid === child.pid)
    if (ours) return ours
    await delay(500)
  }
  throw new Error(`daemon failed to start within 5min — check ${logPath}`)
}
