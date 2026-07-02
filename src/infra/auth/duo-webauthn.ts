import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { CDPSession, Page } from "playwright";
import { log } from "../../utils/log.js";

/**
 * Hands-off Duo MFA via CDP virtual authenticators.
 *
 * One or more WebAuthn credentials are enrolled once as independent Duo security
 * keys (see `src/scripts/ops/duo-webauthn-enroll.ts`) and saved to
 * `DUO_WEBAUTHN_CREDENTIAL_PATH` under `{ credentials: [...] }`. At login time,
 * when the operator opts in with `HR_AUTOMATION_DUO_WEBAUTHN=1`,
 * `beginDuoWebAuthn` loads every saved credential into a Chrome DevTools Protocol
 * virtual authenticator (one per transport) and selects the matching WebAuthn
 * factor at the Duo Universal Prompt. Chrome answers the ceremony automatically
 * (presence + user-verification simulated), so Duo approves with no phone push.
 *
 * Two factors are covered because different UCSD apps offer different ones:
 * - **UCPath** (and most apps) → an `internal`/"Touch ID" platform credential.
 * - **ACT CRM** (Salesforce) → a `usb`/"Security key" roaming credential. CRM
 *   only offers the security-key factor, and Playwright's bundled Chromium lacks
 *   `PublicKeyCredential.isExternalCTAP2SecurityKeySupported`, which Duo probes
 *   before showing that factor — so we shim the method to return `true`.
 *
 * This is **Chromium-only** (CDP `WebAuthn` domain) and entirely opt-in: with
 * the flag unset, `pollDuoApproval` behaves exactly as before (manual approval).
 * Any failure here is non-fatal — the caller falls back to manual Duo.
 *
 * The credential file is guarded by a cross-process lock while a page is armed.
 * Before CDP receives a credential, the runtime also reserves future signCount
 * values on disk; that way an abort or hard kill after Duo observes a signature
 * should not leave the next run replaying a stale counter.
 */

/** Gitignored secrets file holding the enrolled credential(s) (private keys included). */
export const DUO_WEBAUTHN_CREDENTIAL_PATH = ".auth/duo-webauthn.json";
export const DUO_WEBAUTHN_LOCK_DIR = ".auth/duo-webauthn.lock";
export const DUO_WEBAUTHN_SIGNCOUNT_RESERVE = 10;

const DUO_WEBAUTHN_ENV_FLAG = "HR_AUTOMATION_DUO_WEBAUTHN";
const DUO_WEBAUTHN_CREDENTIAL_PATH_ENV = "HR_AUTOMATION_DUO_WEBAUTHN_CREDENTIAL_PATH";
const DUO_WEBAUTHN_LOCK_DIR_ENV = "HR_AUTOMATION_DUO_WEBAUTHN_LOCK_DIR";
const DUO_WEBAUTHN_LOCK_STALE_MS_ENV = "HR_AUTOMATION_DUO_WEBAUTHN_LOCK_STALE_MS";
const DUO_WEBAUTHN_LOCK_STALE_MS = 10 * 60_000;
const DUO_WEBAUTHN_LOCK_POLL_MS = 250;

/** A virtual-authenticator transport. Duo platform devices register `internal`; cross-platform keys `usb`. */
export type DuoWebAuthnTransport = "internal" | "usb";

/**
 * One enrolled Duo WebAuthn credential. `credentialId`, `privateKey`, and
 * `userHandle` are base64 strings exactly as the CDP `WebAuthn` domain produces
 * and consumes them.
 */
export interface DuoWebAuthnCredential {
  /** Registrable domain the credential is scoped to — always `duosecurity.com`. */
  rpId: string;
  /** base64 credential id (the WebAuthn key handle Duo stored at registration). */
  credentialId: string;
  /** base64 PKCS#8 EC P-256 private key. SECRET. */
  privateKey: string;
  /** base64 user handle. Optional for non-resident credentials. */
  userHandle?: string;
  /** Signature counter; persisted and advanced after each assertion. */
  signCount: number;
  /** Whether the credential is discoverable/resident. Duo platform devices are non-resident. */
  isResidentCredential: boolean;
  /** Authenticator transport — drives which prompt factor we select. */
  transport: DuoWebAuthnTransport;
  /** ISO date the credential was enrolled (informational). */
  enrolledAt?: string;
}

/**
 * True when the operator has opted into hands-off Duo via WebAuthn. Pure so the
 * env gate is unit-testable without touching `process.env` globally.
 */
export function isDuoWebAuthnEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[DUO_WEBAUTHN_ENV_FLAG] === "1";
}

function duoWebAuthnCredentialPath(env: NodeJS.ProcessEnv = process.env): string {
  return env[DUO_WEBAUTHN_CREDENTIAL_PATH_ENV]?.trim() || DUO_WEBAUTHN_CREDENTIAL_PATH;
}

function duoWebAuthnLockDir(env: NodeJS.ProcessEnv = process.env): string {
  return env[DUO_WEBAUTHN_LOCK_DIR_ENV]?.trim() || DUO_WEBAUTHN_LOCK_DIR;
}

/**
 * Validate an untrusted parsed JSON value as a single `DuoWebAuthnCredential`.
 * Returns `undefined` (never throws) when any required field is missing or
 * malformed so callers degrade to manual Duo rather than crash a login. Pure.
 */
export function parseDuoWebAuthnCredential(raw: unknown): DuoWebAuthnCredential | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  const str = (v: unknown): v is string => typeof v === "string" && v.length > 0;
  if (!str(r.rpId) || !str(r.credentialId) || !str(r.privateKey)) return undefined;
  if (typeof r.signCount !== "number" || !Number.isFinite(r.signCount)) return undefined;
  const transport = r.transport === "usb" ? "usb" : r.transport === "internal" ? "internal" : undefined;
  if (!transport) return undefined;
  return {
    rpId: r.rpId,
    credentialId: r.credentialId,
    privateKey: r.privateKey,
    ...(str(r.userHandle) ? { userHandle: r.userHandle } : {}),
    signCount: r.signCount,
    isResidentCredential: r.isResidentCredential === true,
    transport,
    ...(str(r.enrolledAt) ? { enrolledAt: r.enrolledAt } : {}),
  };
}

/**
 * Parse the credential-file payload into zero or more credentials. Accepts both
 * the multi-credential shape `{ credentials: [...] }` and a legacy single
 * top-level credential object. Structurally-invalid entries are dropped (so a
 * partially-bad file still yields the usable credentials). Pure — no I/O.
 */
export function parseDuoWebAuthnCredentials(raw: unknown): DuoWebAuthnCredential[] {
  if (raw && typeof raw === "object" && Array.isArray((raw as { credentials?: unknown }).credentials)) {
    return (raw as { credentials: unknown[] }).credentials
      .map((c) => parseDuoWebAuthnCredential(c))
      .filter((c): c is DuoWebAuthnCredential => c !== undefined);
  }
  const single = parseDuoWebAuthnCredential(raw);
  return single ? [single] : [];
}

/**
 * Which Duo prompt factor to click for a given transport. Platform credentials
 * (`internal`) surface as the "Touch ID" factor; cross-platform keys (`usb`) as
 * "Security key". Pure — used by the runtime selector and unit-tested.
 */
export function factorPatternForTransport(transport: DuoWebAuthnTransport): RegExp {
  return transport === "usb" ? /security key/i : /touch id/i;
}

/**
 * Merge a freshly-enrolled credential into the existing set, keyed by transport:
 * a machine has at most one platform (`internal`) and one roaming (`usb`)
 * authenticator, so re-enrolling a transport replaces its prior entry while
 * preserving the other. Pure — used by the enrollment script and unit-tested.
 */
export function mergeDuoWebAuthnCredential(
  existing: DuoWebAuthnCredential[],
  next: DuoWebAuthnCredential,
): DuoWebAuthnCredential[] {
  return [
    ...existing.filter((c) => c.transport !== next.transport && c.credentialId !== next.credentialId),
    next,
  ];
}

/**
 * Monotonic signature counter merge. WebAuthn servers may treat a counter that
 * does not advance as a cloned-authenticator signal, so we persist the larger
 * of the saved and freshly-observed counts. Pure.
 */
export function nextSignCount(saved: number, observed: number | undefined): number {
  return Math.max(saved, observed ?? 0, 0);
}

export interface DuoWebAuthnLock {
  release(): void;
}

interface DuoWebAuthnLockOwner {
  pid: number;
  token: string;
  acquiredAt: string;
  updatedAt: string;
}

function numericEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function duoWebAuthnAbortReason(signal: AbortSignal): Error {
  const reason = signal.reason;
  return reason instanceof Error ? reason : new Error(reason ? String(reason) : "Duo WebAuthn lock wait aborted");
}

async function waitForDuoWebAuthnLock(ms: number, abortSignal?: AbortSignal): Promise<void> {
  try {
    await sleep(ms, undefined, { signal: abortSignal });
  } catch (err) {
    if (abortSignal?.aborted) throw duoWebAuthnAbortReason(abortSignal);
    throw err;
  }
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readLockOwner(ownerPath: string): DuoWebAuthnLockOwner | undefined {
  try {
    const raw = JSON.parse(readFileSync(ownerPath, "utf8")) as Partial<DuoWebAuthnLockOwner>;
    if (
      typeof raw.pid === "number" &&
      typeof raw.token === "string" &&
      typeof raw.acquiredAt === "string" &&
      typeof raw.updatedAt === "string"
    ) {
      return raw as DuoWebAuthnLockOwner;
    }
  } catch {
    /* missing/corrupt owner metadata falls back to mtime staleness */
  }
  return undefined;
}

function lockMtimeMs(lockDir: string, ownerPath: string): number {
  try {
    return statSync(ownerPath).mtimeMs;
  } catch {
    return statSync(lockDir).mtimeMs;
  }
}

function isDuoWebAuthnLockStale(lockDir: string, ownerPath: string, staleMs: number): boolean {
  const owner = readLockOwner(ownerPath);
  if (owner && !isProcessAlive(owner.pid)) return true;
  try {
    return Date.now() - lockMtimeMs(lockDir, ownerPath) > staleMs;
  } catch {
    return true;
  }
}

function writeLockOwner(ownerPath: string, owner: DuoWebAuthnLockOwner): void {
  writeFileSync(ownerPath, `${JSON.stringify(owner)}\n`, { encoding: "utf8", mode: 0o600 });
}

export async function acquireDuoWebAuthnLock(
  opts: {
    abortSignal?: AbortSignal;
    lockDir?: string;
    staleMs?: number;
    pollMs?: number;
  } = {},
): Promise<DuoWebAuthnLock> {
  const lockDir = opts.lockDir ?? duoWebAuthnLockDir();
  const ownerPath = join(lockDir, "owner.json");
  const staleMs = opts.staleMs ?? numericEnv(DUO_WEBAUTHN_LOCK_STALE_MS_ENV, DUO_WEBAUTHN_LOCK_STALE_MS);
  const pollMs = opts.pollMs ?? DUO_WEBAUTHN_LOCK_POLL_MS;

  mkdirSync(dirname(lockDir), { recursive: true, mode: 0o700 });
  while (true) {
    opts.abortSignal?.throwIfAborted();
    try {
      mkdirSync(lockDir, { mode: 0o700 });
      break;
    } catch (err) {
      if (!(err && typeof err === "object" && "code" in err && err.code === "EEXIST")) throw err;
      if (isDuoWebAuthnLockStale(lockDir, ownerPath, staleMs)) {
        rmSync(lockDir, { recursive: true, force: true });
        continue;
      }
      await waitForDuoWebAuthnLock(pollMs, opts.abortSignal);
    }
  }

  const token = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const owner: DuoWebAuthnLockOwner = {
    pid: process.pid,
    token,
    acquiredAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  try {
    writeLockOwner(ownerPath, owner);
  } catch (err) {
    rmSync(lockDir, { recursive: true, force: true });
    throw err;
  }

  let released = false;
  const stillOwner = (): boolean => readLockOwner(ownerPath)?.token === token;
  const heartbeat = setInterval(() => {
    try {
      if (!stillOwner()) return;
      writeLockOwner(ownerPath, { ...owner, updatedAt: new Date().toISOString() });
    } catch {
      /* lock may have been released or stolen */
    }
  }, Math.min(5_000, Math.max(1_000, staleMs / 4)));
  heartbeat.unref?.();

  return {
    release: () => {
      if (released) return;
      released = true;
      clearInterval(heartbeat);
      if (stillOwner()) rmSync(lockDir, { recursive: true, force: true });
    },
  };
}

export function reserveDuoWebAuthnSignCounts(
  credentials: DuoWebAuthnCredential[],
  path: string = duoWebAuthnCredentialPath(),
  reserveBy: number = DUO_WEBAUTHN_SIGNCOUNT_RESERVE,
): boolean {
  if (credentials.length === 0) return true;
  const targetIds = new Set(credentials.map((c) => c.credentialId));
  const reserve = Math.max(1, Math.trunc(reserveBy));

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return false;
  }

  const reserveOne = (entry: unknown): boolean => {
    if (!entry || typeof entry !== "object") return false;
    const c = entry as { credentialId?: unknown; signCount?: unknown };
    if (typeof c.credentialId !== "string" || !targetIds.has(c.credentialId)) return false;
    const current = typeof c.signCount === "number" && Number.isFinite(c.signCount) ? c.signCount : 0;
    c.signCount = Math.max(current, 0) + reserve;
    return true;
  };

  let changed = false;
  if (raw && typeof raw === "object" && Array.isArray((raw as { credentials?: unknown }).credentials)) {
    for (const entry of (raw as { credentials: unknown[] }).credentials) {
      changed = reserveOne(entry) || changed;
    }
  } else {
    changed = reserveOne(raw);
  }
  if (!changed) return false;

  try {
    writeFileSync(path, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
    return true;
  } catch {
    return false;
  }
}

/**
 * Resync margin applied when a hands-off assertion *signed* but Duo never
 * completed — the signature of a signCount drift: the local counter fell at/below
 * Duo's server-side counter, so Duo treats the assertion as a possible clone and
 * silently refuses to advance (the prompt hangs on "Use Touch ID"). Deliberately
 * larger than {@link DUO_WEBAUTHN_SIGNCOUNT_RESERVE} so a *single* login retry
 * clears even a multi-step drift within the kernel's 3-attempt budget — the +10
 * reserve alone only leapfrogs +10 per attempt, so a drift > +30 would exhaust
 * the retries before recovering.
 */
export const DUO_WEBAUTHN_SIGNCOUNT_RESYNC = 100;

/**
 * Jump every enrolled credential's persisted signCount forward by `margin` so the
 * NEXT {@link armDuoWebAuthn} seeds the CDP authenticator above Duo's server-side
 * counter. Called from the poll loop when a WebAuthn assertion signed but did not
 * complete (the clone-rejection hang). Best-effort and design-consistent — reuses
 * {@link reserveDuoWebAuthnSignCounts}'s monotonic file bump, so it is safe even
 * when the failure was not counter-related (counters only ever move forward).
 * Returns true when the file was bumped, false when no credential is
 * available/writable.
 */
export function resyncDuoWebAuthnSignCounts(
  path: string = duoWebAuthnCredentialPath(),
  margin: number = DUO_WEBAUTHN_SIGNCOUNT_RESYNC,
): boolean {
  const creds = loadDuoWebAuthnCredentials(path);
  if (creds.length === 0) return false;
  return reserveDuoWebAuthnSignCounts(creds, path, margin);
}

/**
 * Read + validate a single enrolled credential. Returns `undefined` (logs why)
 * when absent/invalid. Retained for the legacy single-object file shape and unit
 * tests; the runtime uses {@link loadDuoWebAuthnCredentials}.
 */
export function loadDuoWebAuthnCredential(
  path: string = duoWebAuthnCredentialPath(),
): DuoWebAuthnCredential | undefined {
  return loadDuoWebAuthnCredentials(path)[0];
}

/**
 * Read + validate every enrolled credential from the secrets file. Returns an
 * empty array (logging why) when the file is absent, unreadable, not JSON, or
 * holds no valid credential — callers then degrade to manual Duo.
 */
export function loadDuoWebAuthnCredentials(
  path: string = duoWebAuthnCredentialPath(),
): DuoWebAuthnCredential[] {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    log.warn(
      `Duo WebAuthn enabled but no credential at ${path} — run \`npm run duo:webauthn:enroll\` or unset ${DUO_WEBAUTHN_ENV_FLAG}. Falling back to manual Duo.`,
    );
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    log.warn(`Duo WebAuthn credential at ${path} is not valid JSON — falling back to manual Duo.`);
    return [];
  }
  const creds = parseDuoWebAuthnCredentials(parsed);
  if (creds.length === 0) {
    log.warn(`Duo WebAuthn credential at ${path} is missing required fields — falling back to manual Duo.`);
  }
  return creds;
}

/**
 * Persist advanced signature counters back to the secrets file (best-effort).
 * Re-reads the file so a concurrent enrollment isn't clobbered, then for each
 * credential present (in either the `{ credentials: [...] }` or legacy
 * single-object shape) bumps `signCount` to `max(current, observed)`.
 */
function persistSignCounts(observed: Map<string, number>, path: string): void {
  if (observed.size === 0) return;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return;
  }

  const bump = (entry: unknown): boolean => {
    if (!entry || typeof entry !== "object") return false;
    const c = entry as { credentialId?: unknown; signCount?: unknown };
    if (typeof c.credentialId !== "string") return false;
    const obs = observed.get(c.credentialId);
    if (obs === undefined) return false;
    const current = typeof c.signCount === "number" ? c.signCount : 0;
    const next = nextSignCount(current, obs);
    if (next === current) return false;
    c.signCount = next;
    return true;
  };

  let changed = false;
  if (raw && typeof raw === "object" && Array.isArray((raw as { credentials?: unknown }).credentials)) {
    for (const entry of (raw as { credentials: unknown[] }).credentials) {
      changed = bump(entry) || changed;
    }
  } else {
    changed = bump(raw);
  }
  if (!changed) return;

  try {
    writeFileSync(path, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
  } catch (err) {
    log.warn(`Could not persist Duo WebAuthn signCount to ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Browser-side shim injected before the Duo prompt scripts run. Duo gates the
 * "Security key" factor behind `PublicKeyCredential.isExternalCTAP2SecurityKeySupported()`,
 * which is **absent** in Playwright's bundled Chromium — so without this, Duo
 * greys the factor as "Not supported in this browser". Forcing it to resolve
 * `true` makes Duo offer the factor, which our virtual `usb` authenticator then
 * answers. Self-contained (runs in the page; references only browser globals).
 */
export function ctap2SupportShim(): void {
  try {
    const pkc = (globalThis as unknown as { PublicKeyCredential?: Record<string, unknown> }).PublicKeyCredential;
    if (pkc) {
      pkc.isExternalCTAP2SecurityKeySupported = () => Promise.resolve(true);
    }
  } catch {
    /* ignore — shim is best-effort */
  }
}

/**
 * An active virtual-authenticator session. The caller selects/awaits approval
 * via the normal poll, then calls `finish` to persist counters and tear the
 * authenticator(s) down regardless of outcome.
 */
export interface DuoWebAuthnHandle {
  /** Human label of the factor that was selected (e.g. "Touch ID"). */
  factorLabel: string;
  /** Persist signCounts (only when approved) and remove the virtual authenticator(s). Never throws. */
  finish(opts: { approved: boolean }): Promise<void>;
}

interface AddAuthenticatorResult {
  authenticatorId: string;
}
interface GetCredentialsResult {
  credentials: Array<{ credentialId: string; signCount: number }>;
}

async function addVirtualAuthenticator(cdp: CDPSession, transport: DuoWebAuthnTransport): Promise<string> {
  const res = (await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport,
      // `usb` must hold a discoverable (resident) credential so CRM's auto-fired
      // passkey request on prompt-load is answered by the virtual authenticator,
      // instead of stalling on Chrome's native "insert your security key" dialog.
      hasResidentKey: transport === "usb",
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  })) as AddAuthenticatorResult;
  return res.authenticatorId;
}

/**
 * Resolve the WebAuthn ceremony at the Duo Universal Prompt, in two phases.
 *
 * **Phase 1 — auto-fire grace (no clicking).** Platform-factor apps (UCPath,
 * UKG, Kuali, New Kronos) auto-trigger the Touch ID ceremony on prompt load; the
 * pre-armed virtual authenticator answers it with no interaction and Duo
 * redirects to the app in ~3s. We must NOT click during this window — clicking
 * "Other options" navigates away from the in-flight ceremony and aborts it, and
 * UCPath then throws a Duo `/error` when a factor is picked on the all_methods
 * list. We watch `hasSigned`/the trust screen/the URL and return `"auto"` the
 * moment the ceremony lands. CRM's roaming-key native dialog won't self-answer,
 * so we bail to Phase 2 as soon as that dialog's text appears.
 *
 * **Phase 2 — explicit factor selection.** For CRM (security-key only) and any
 * app whose auto-fire didn't land. `factorRes` is in **preference order** — the
 * most-preferred factor is attempted in every state, but a *less*-preferred
 * factor is only clicked once the full "Other options to log in" list is open, so
 * a default screen showing a non-preferred factor doesn't pre-empt the preferred
 * one when both are enrolled.
 *
 * Phase 2 handles the prompt states seen in production:
 * - the factor list shown directly;
 * - a default-factor screen with an "Other options" link (revealed once);
 * - a stuck "Use Touch ID / Use your security key" sub-screen — for which the
 *   click path (Other options → factor) fires a **fresh** in-session ceremony.
 *   ACT CRM auto-fires a discoverable-passkey request on prompt load (before any
 *   authenticator exists), landing on this screen; we never reload (reloading
 *   desyncs Duo's challenge — it signs but never completes), we click through it.
 *
 * The reveal/back clicks fire **at most once each** — repeated clicking thrashes
 * the prompt — and once the full list is on screen without any of our factors,
 * it bails within ~3s instead of polling the whole timeout. Returns the clicked
 * factor's label, or `undefined` so the caller falls back to manual Duo.
 */
// The factor-detection window for an ALREADY-RENDERED Duo prompt. Env-tunable so
// the ISS-005 pre-prompt guard below can be exercised deterministically (shrink
// it and the deadline reliably elapses before the prompt renders).
const DUO_FACTOR_TIMEOUT_MS = numericEnv("HR_DUO_FACTOR_TIMEOUT_MS", 20_000);

// Extra time beyond the factor-detection window to let a SLOW first-attempt
// SSO→Duo transition actually render the prompt before falling back to manual
// (the ISS-005 flake). Bounds the wait in selectDuoFactor.
const DUO_FACTOR_PROMPT_RENDER_GRACE_MS = numericEnv("HR_DUO_PROMPT_RENDER_GRACE_MS", 25_000);

export async function selectDuoFactor(
  page: Page,
  factorRes: RegExp[],
  timeoutMs: number,
  abortSignal?: AbortSignal,
  hasSigned?: () => Promise<boolean>,
  // Injectable clock — defaults to the wall clock. The ISS-005 pre-prompt guard
  // is timing-dependent (factor deadline vs. an absolute render cap), so a unit
  // test drives it deterministically by advancing virtual time (see
  // duo-webauthn.test.ts) instead of sleeping through the real ~45s window.
  now: () => number = Date.now,
): Promise<string | undefined> {
  const deadline = now() + timeoutMs;
  let revealedList = false;
  let steppedBack = false;
  let listFirstSeenAt = 0;

  const clickFactor = async (re: RegExp): Promise<string | undefined> => {
    const factor = page.getByRole("link", { name: re }).first();
    if ((await factor.count()) > 0) {
      const label = (await factor.innerText().catch(() => "")).split("\n")[0]?.trim() || "WebAuthn";
      await factor.click({ timeout: 5_000 });
      return label;
    }
    return undefined;
  };

  // ── Phase 1: auto-fire grace — do NOT click yet ──
  // UCPath (and other platform-factor apps) auto-trigger the Touch ID ceremony on
  // prompt load; the pre-armed virtual authenticator answers it with no click and
  // Duo redirects straight to the app in ~3s (verified live). Clicking "Other
  // options" here navigates AWAY from that in-flight ceremony and aborts it —
  // UCPath then throws a Duo /error when a factor is clicked on the all_methods
  // list. So give the auto-fire a chance to land first. Return "auto" the instant
  // the authenticator signs / the trust screen shows / the page leaves Duo; bail
  // to the click path early only for CRM's roaming-key native dialog, which won't
  // self-answer.
  if (hasSigned) {
    const graceDeadline = Math.min(deadline, now() + 12_000);
    while (now() < graceDeadline) {
      abortSignal?.throwIfAborted();
      try {
        // The authenticator answered the auto-fired ceremony — authoritative.
        // (Do NOT treat "not on duosecurity.com" as success here: the SSO→Duo
        // redirect can still be in flight, leaving the page on a5.ucsd.edu, which
        // is pre-prompt, not post-success.)
        if (await hasSigned()) return "auto";
        if ((await page.getByText(/yes, this is my device/i).count().catch(() => 0)) > 0) return "auto";
        // OnBase / CRM may auto-fire a security-key ceremony on prompt load. Do
        // NOT bail to the click path the instant the screen appears — the pre-armed
        // `usb` virtual authenticator can answer it hands-off (same as Touch ID
        // auto-fire for UCPath). Phase 2 (Escape → Other options → factor) is the
        // fallback when the grace window expires without a signature.
      } catch {
        /* page mid-navigation between SSO and the prompt — keep waiting */
      }
      await page.waitForTimeout(400);
    }
  }

  // ── Phase 2: explicit factor selection (CRM, or an auto-fire that didn't land) ──
  //
  // ISS-005 guard: `timeoutMs` sizes the factor window for an ALREADY-RENDERED
  // prompt. On a slow first-attempt SSO→Duo transition it can elapse while the
  // page is STILL pre-prompt (on a5.ucsd.edu/tritON SSO — captured live: all Duo
  // screens absent, only SSO login-page chrome present). Giving up there falls
  // back to a dead manual wait (no prompt to approve, no push on a WebAuthn
  // prompt) that burns the whole manual timeout before a warm attempt 2 recovers.
  // So loop to an absolute `promptRenderCap` and only give up at the factor
  // deadline once a Duo screen has actually rendered.
  const promptRenderCap = now() + Math.max(timeoutMs, 20_000) + DUO_FACTOR_PROMPT_RENDER_GRACE_MS;
  let factorDeadline = deadline;
  let extendedForRender = false;
  const duoPromptRendered = async (): Promise<boolean> => {
    if (hasSigned && (await hasSigned().catch(() => false))) return true;
    const counts = await Promise.all([
      page.getByText(/other options to log in|other options|other methods/i).count().catch(() => 0),
      page.getByText(/use touch id|verify your identity using this device/i).count().catch(() => 0),
      page.getByText(/insert your security key|use your security key/i).count().catch(() => 0),
      page.getByText(/yes, this is my device/i).count().catch(() => 0),
      page
        .getByRole("link", { name: /duo push|passcode|bypass code|touch id|security key/i })
        .count()
        .catch(() => 0),
    ]);
    return counts.some((c) => c > 0);
  };
  while (now() < promptRenderCap) {
    abortSignal?.throwIfAborted();
    try {
      // Auto-fire may still complete mid-click-path (e.g. CRM after Escape): if the
      // authenticator has signed and we've left the Duo host, report success.
      if (hasSigned && !page.url().includes("duosecurity.com") && (await hasSigned())) {
        return "auto";
      }

      // CRM's auto-fired passkey request, once answered by the pre-armed
      // resident authenticator, lands on the "Yes, this is my device" trust
      // screen — there's no factor to click. Signal the caller to proceed to
      // the approval wait (which clicks trust + detects the success URL).
      if ((await page.getByText(/yes, this is my device/i).count().catch(() => 0)) > 0) {
        return "auto";
      }

      // Is the full method list ("Other options to log in") on screen?
      const onMethodList =
        (await page.getByText(/other options to log in/i).count().catch(() => 0)) > 0 ||
        (await page
          .getByRole("link", { name: /duo push|duo mobile passcode|bypass code/i })
          .count()
          .catch(() => 0)) > 0;

      // 1. Always try the most-preferred factor first, in any state.
      const preferred = await clickFactor(factorRes[0]!);
      if (preferred) return preferred;

      if (onMethodList || revealedList) {
        // The full list is open — only now settle for lower-preference factors.
        for (const re of factorRes.slice(1)) {
          const clicked = await clickFactor(re);
          if (clicked) return clicked;
        }
        // List is open but none of our factors are present — brief grace, then bail.
        if (!listFirstSeenAt) listFirstSeenAt = now();
        else if (now() - listFirstSeenAt > 3_000) {
          await snapshotDuoPromptState(page, "method list open but none of our factors present");
          return undefined;
        }
      } else if (!revealedList) {
        // CRM auto-fires a discoverable passkey request on load; if Chrome's
        // native "insert your security key" dialog is up it blocks the DOM
        // "Other options" click — press Escape to cancel that ceremony first.
        const stuckOnSecurityKey =
          (await page.getByText(/insert your security key|use your security key/i).count().catch(() => 0)) > 0;
        if (stuckOnSecurityKey) {
          log.step("Duo: dismissing native security-key dialog before the click path");
          await page.keyboard.press("Escape").catch(() => {});
          await page.waitForTimeout(500);
        }

        // A default-factor or stuck "Use <factor>" screen hides the list behind
        // "Other options" — reveal once so our factors become clickable.
        const other = page
          .getByRole("link", { name: /other options|other methods/i })
          .or(page.getByRole("button", { name: /other options|other methods/i }))
          .first();
        if ((await other.count()) > 0) {
          await other.click({ timeout: 3_000 }).catch(() => {});
          revealedList = true;
          // Let the options list finish navigating/rendering before clicking a
          // factor — clicking mid-render lands on a transitioning element and
          // Duo throws an /error page (the UCPath race).
          await page.waitForTimeout(1_500);
        } else if (!steppedBack) {
          // Possibly stuck on a "Use <factor>" sub-screen with no list link — step back once.
          const back = page.getByRole("button", { name: /back/i }).first();
          if ((await back.count()) > 0) {
            await back.click({ timeout: 3_000 }).catch(() => {});
            steppedBack = true;
          }
        }
      }
    } catch {
      // Page may be mid-navigation between SSO and the Duo prompt — retry.
    }

    if (now() >= factorDeadline) {
      // The factor window elapsed. If NO Duo screen has rendered yet we're still
      // pre-prompt (the ISS-005 slow-transition case) — keep waiting up to the
      // absolute cap instead of falling back to a dead manual wait. Only give up
      // once the prompt is genuinely up with no matching factor, or the cap trips.
      if (!(await duoPromptRendered()) && now() < promptRenderCap) {
        if (!extendedForRender) {
          log.step(
            "Duo: prompt not rendered within the factor window — waiting for the SSO→Duo transition (ISS-005 guard)",
          );
          extendedForRender = true;
        }
        factorDeadline = Math.min(promptRenderCap, now() + timeoutMs);
      } else {
        break; // prompt is up but no factor matched, or the hard cap tripped — real give-up
      }
    }
    await page.waitForTimeout(600);
  }
  await snapshotDuoPromptState(
    page,
    extendedForRender
      ? "hard cap reached before a matching factor rendered (ISS-005 guard exhausted)"
      : "deadline elapsed before any factor matched (the ISS-005 first-attempt flake)",
  );
  return undefined;
}

/**
 * Diagnostic snapshot of the live Duo prompt at the moment `selectDuoFactor`
 * GIVES UP (returns undefined → caller logs "factor not found" → manual
 * fallback → ~180s stall). The intermittent first-attempt failure (ISS-005)
 * left no evidence of WHY no matching factor was on the prompt — was the
 * ceremony screen not yet rendered, on a different sub-screen, or showing a
 * factor whose label didn't match the transport pattern? This captures the
 * prompt's actual state (url + which known screens are visible + the literal
 * link labels present) so the NEXT occurrence — in production or the looped
 * `scripts/duo-firstattempt-soak.sh` harness — is diagnosable from the logs.
 *
 * Purely observational: it only reads (locator counts + innerText — NO
 * `page.evaluate`, avoiding the `__name` keep-names browser-eval gotcha) and
 * NEVER throws (a snapshot failure must not perturb the auth fallback path).
 */
async function snapshotDuoPromptState(page: Page, reason: string): Promise<void> {
  try {
    const url = page.url();
    const seen = async (re: RegExp): Promise<boolean> =>
      (await page.getByText(re).count().catch(() => 0)) > 0;
    const [onMethodList, useTouchId, useSecurityKey, trustScreen, otherOptions] = await Promise.all([
      seen(/other options to log in/i),
      seen(/use touch id|verify your identity using this device/i),
      seen(/insert your security key|use your security key/i),
      seen(/yes, this is my device/i),
      seen(/other options|other methods/i),
    ]);
    // Enumerate the literal factor/option link labels actually on the prompt so
    // a label/transport mismatch (the leading first-attempt hypothesis) is
    // visible. Locator-based, capped, best-effort.
    let linkLabels: string[] = [];
    try {
      const links = await page.getByRole("link").all();
      const texts = await Promise.all(links.slice(0, 25).map((l) => l.innerText().catch(() => "")));
      linkLabels = texts.map((t) => t.split("\n")[0]?.trim() ?? "").filter(Boolean);
    } catch {
      /* best-effort link enumeration */
    }
    log.warn(
      `Duo WebAuthn factor-detection diagnostic — ${reason} | url=${url} ` +
        `onMethodList=${onMethodList} useTouchId=${useTouchId} useSecurityKey=${useSecurityKey} ` +
        `trustScreen=${trustScreen} otherOptions=${otherOptions} | links=[${linkLabels.join(" | ")}]`,
    );
  } catch (err) {
    log.warn(
      `Duo WebAuthn factor-detection diagnostic failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** Active virtual-authenticator state for one page, established by `armDuoWebAuthn`. */
interface ArmedDuoWebAuthn {
  cdp: CDPSession;
  authByTransport: Map<DuoWebAuthnTransport, string>;
  setups: Array<{ cred: DuoWebAuthnCredential; authenticatorId: string }>;
  lock: DuoWebAuthnLock;
}

/** One armed authenticator set per page — armed before the prompt, finished after. */
const armedByPage = new WeakMap<Page, ArmedDuoWebAuthn>();

/**
 * Set up CDP virtual authenticators from the saved credential(s) on `page`, once.
 *
 * **Must run before the Duo prompt loads.** ACT CRM auto-fires a discoverable
 * passkey request the instant its prompt renders; if no authenticator exists
 * yet, Chrome shows a native "insert your security key" dialog that can't be
 * dismissed from the page, and a later-added authenticator won't answer the
 * already-pending request. Arming at `clickSsoSubmit` (the step right before the
 * prompt) lets the resident `usb` authenticator answer that auto-fire
 * automatically. Idempotent per page (cached in `armedByPage`); returns true when
 * an authenticator with ≥1 credential is ready, false (logged) otherwise so
 * callers degrade to manual Duo.
 */
export async function armDuoWebAuthn(page: Page, opts: { abortSignal?: AbortSignal } = {}): Promise<boolean> {
  const existing = armedByPage.get(page);
  if (existing) {
    // Defense-in-depth: the page may have been reloaded out from under us (e.g.
    // an idle-refresh tick that slipped past the auth guard) — that destroys
    // the CDP target, so the cached authenticator is dead even though the
    // WeakMap (keyed by the Page object, which survives a reload) still reports
    // the page as armed. Probe the stored CDP session; if it's live, the
    // cached arm is reusable. If the probe throws, the target is stale — tear
    // the stale entry down (release its cross-process lock) and re-arm fresh
    // below instead of returning a phantom "armed: true".
    try {
      await existing.cdp.send("WebAuthn.enable");
      return true;
    } catch {
      log.warn("Duo WebAuthn: cached CDP authenticator is stale (page likely reloaded) — re-arming fresh.");
      armedByPage.delete(page);
      try {
        await existing.cdp.detach().catch(() => {});
      } catch {
        /* best-effort */
      }
      existing.lock.release();
      // Fall through to a fresh arm.
    }
  }
  let creds = loadDuoWebAuthnCredentials();
  if (creds.length === 0) return false;

  let cdp: CDPSession | undefined;
  let lock: DuoWebAuthnLock | undefined;
  const authByTransport = new Map<DuoWebAuthnTransport, string>();
  const setups: Array<{ cred: DuoWebAuthnCredential; authenticatorId: string }> = [];
  try {
    lock = await acquireDuoWebAuthnLock({ abortSignal: opts.abortSignal });

    // Re-read after acquiring the cross-process lock so this browser seeds from
    // the latest counter persisted by the previous hands-off login.
    creds = loadDuoWebAuthnCredentials();
    if (creds.length === 0) throw new Error("no Duo WebAuthn credentials available after lock acquisition");
    if (!reserveDuoWebAuthnSignCounts(creds)) {
      throw new Error("could not reserve Duo WebAuthn signCount before arming");
    }

    // Distinct transports, internal first — Chrome allows only one `internal`
    // authenticator per environment, so it's the constrained add; doing it first
    // keeps the clear/retry below from discarding an already-created `usb` one.
    const transports = [...new Set(creds.map((c) => c.transport))].sort((a, b) =>
      a === "internal" ? -1 : b === "internal" ? 1 : 0,
    );
    const hasUsb = transports.includes("usb");

    cdp = await page.context().newCDPSession(page);

    // CRM probes `isExternalCTAP2SecurityKeySupported` (absent in Playwright
    // Chromium) before offering the security-key factor — shim it true. Inject
    // for future navigations (addInitScript) and the current document (evaluate).
    if (hasUsb) {
      await page.addInitScript(ctap2SupportShim).catch(() => {});
      await page.evaluate(ctap2SupportShim).catch(() => {});
    }

    // Clear any virtual authenticator dangling in this browser environment
    // (Chrome allows only one `internal` authenticator at a time).
    await cdp.send("WebAuthn.enable").catch(() => {});
    await cdp.send("WebAuthn.disable").catch(() => {});
    await cdp.send("WebAuthn.enable");

    for (const transport of transports) {
      let authenticatorId: string;
      try {
        authenticatorId = await addVirtualAuthenticator(cdp, transport);
      } catch {
        // Only the constrained `internal` add should ever hit this, and it's
        // first in the loop, so a clear+retry can't lose another authenticator.
        if (transport !== "internal") throw new Error(`addVirtualAuthenticator(${transport}) failed`);
        await cdp.send("WebAuthn.disable").catch(() => {});
        await cdp.send("WebAuthn.enable");
        authenticatorId = await addVirtualAuthenticator(cdp, transport);
      }
      authByTransport.set(transport, authenticatorId);
    }

    for (const cred of creds) {
      const authenticatorId = authByTransport.get(cred.transport);
      if (!authenticatorId) continue;
      // Store the usb credential as discoverable (needs a userHandle) so the
      // resident `usb` authenticator can answer CRM's auto-fired passkey request.
      const discoverable = cred.transport === "usb" && Boolean(cred.userHandle);
      await cdp.send("WebAuthn.addCredential", {
        authenticatorId,
        credential: {
          credentialId: cred.credentialId,
          isResidentCredential: discoverable || cred.isResidentCredential,
          rpId: cred.rpId,
          privateKey: cred.privateKey,
          ...(cred.userHandle ? { userHandle: cred.userHandle } : {}),
          signCount: cred.signCount,
        },
      });
      setups.push({ cred, authenticatorId });
    }
    if (setups.length === 0) throw new Error("no credential could be registered to an authenticator");
  } catch (err) {
    for (const authenticatorId of authByTransport.values()) {
      await cdp?.send("WebAuthn.removeVirtualAuthenticator", { authenticatorId }).catch(() => {});
    }
    await cdp?.send("WebAuthn.disable").catch(() => {});
    await cdp?.detach().catch(() => {});
    log.warn(
      `Duo WebAuthn virtual authenticator setup failed (${err instanceof Error ? err.message : String(err)}) — falling back to manual Duo.`,
    );
    lock?.release();
    if (opts.abortSignal?.aborted) throw err;
    return false;
  }

  if (!cdp || !lock) {
    lock?.release();
    return false;
  }

  armedByPage.set(page, { cdp, authByTransport, setups, lock });
  log.step(`Duo WebAuthn armed (${[...authByTransport.keys()].join(", ")}) — hands-off approval enabled`);
  return true;
}

/**
 * Read back each credential's signature counter (best-effort), persist the
 * monotonic max to the credential file, and tear the page's virtual
 * authenticator(s) down. Idempotent — a no-op if the page was never armed or was
 * already finished.
 *
 * signCount is persisted **unconditionally**: if the authenticator signed at all
 * (even on an attempt that didn't complete), Duo observed the advanced counter,
 * and persisting only on success could leave the file behind Duo's view and get
 * the next assertion rejected as a clone. Arming pre-reserves counter headroom;
 * finish still reads back the observed value in case a prompt signs more than
 * the reserved window expected.
 */
export async function finishDuoWebAuthn(page: Page): Promise<void> {
  const armed = armedByPage.get(page);
  if (!armed) return;
  armedByPage.delete(page);
  const { cdp, authByTransport, setups, lock } = armed;

  const observed = new Map<string, number>();
  for (const { cred, authenticatorId } of setups) {
    try {
      const got = (await cdp.send("WebAuthn.getCredentials", { authenticatorId })) as GetCredentialsResult;
      const sc = got.credentials.find((c) => c.credentialId === cred.credentialId)?.signCount;
      if (typeof sc === "number") observed.set(cred.credentialId, sc);
    } catch {
      /* counter readback is best-effort */
    }
  }
  persistSignCounts(observed, duoWebAuthnCredentialPath());

  try {
    for (const authenticatorId of authByTransport.values()) {
      await cdp.send("WebAuthn.removeVirtualAuthenticator", { authenticatorId }).catch(() => {});
    }
    await cdp.send("WebAuthn.disable").catch(() => {});
    await cdp.detach().catch(() => {});
  } catch {
    /* best-effort */
  } finally {
    lock.release();
  }
}

/**
 * Ensure the page is armed (arming now if `clickSsoSubmit` didn't reach it — only
 * too late for CRM's auto-fire, fine for click-driven factors like UCPath's Touch
 * ID), then select the WebAuthn factor at the Duo prompt. Returns a handle when
 * WebAuthn is in play — either a factor was clicked (UCPath → Touch ID) or the
 * pre-armed authenticator already answered an auto-fired request and we're on the
 * trust screen (CRM). `undefined` when no authenticator is available or no
 * factor/auto-fire is detected, so the caller falls back to manual Duo.
 *
 * @param factorTimeoutMs how long to wait for the Duo prompt's factor to appear
 */
export async function beginDuoWebAuthn(
  page: Page,
  opts: { abortSignal?: AbortSignal; factorTimeoutMs?: number } = {},
): Promise<DuoWebAuthnHandle | undefined> {
  if (!(await armDuoWebAuthn(page, { abortSignal: opts.abortSignal }))) return undefined;
  const armed = armedByPage.get(page)!;

  // Factor preference: Touch ID (`internal`) first where an app offers it — it's
  // accepted hands-off across UCSD apps. Security key (`usb`) is the fallback for
  // apps with no Touch ID (ACT CRM). A security key registered at the Duo account
  // level is still rejected by some apps' policies (UCPath returns a Duo /error
  // page if picked), so it must not pre-empt a working Touch ID — `selectDuoFactor`
  // reveals the full options list before settling for the fallback.
  const preferenceOrder = [...new Set(armed.setups.map((s) => s.cred.transport))].sort((a, b) =>
    a === "internal" ? -1 : b === "internal" ? 1 : 0,
  );

  // signCount probe for the silent auto-fire fast path: true once any armed
  // credential's counter has advanced past where it started this run — i.e. the
  // virtual authenticator answered an (auto-fired) ceremony. Compared per
  // credential against the values loaded at arm time.
  const initialSignCount = new Map(armed.setups.map((s) => [s.cred.credentialId, s.cred.signCount]));
  const hasSigned = async (): Promise<boolean> => {
    for (const { cred, authenticatorId } of armed.setups) {
      try {
        const got = (await armed.cdp.send("WebAuthn.getCredentials", {
          authenticatorId,
        })) as GetCredentialsResult;
        const sc = got.credentials.find((c) => c.credentialId === cred.credentialId)?.signCount;
        if (typeof sc === "number" && sc > (initialSignCount.get(cred.credentialId) ?? 0)) {
          return true;
        }
      } catch {
        /* best-effort — readback failure just means we keep polling for a factor */
      }
    }
    return false;
  };

  const factorLabel = await selectDuoFactor(
    page,
    preferenceOrder.map(factorPatternForTransport),
    opts.factorTimeoutMs ?? DUO_FACTOR_TIMEOUT_MS,
    opts.abortSignal,
    hasSigned,
  );
  if (!factorLabel) {
    log.warn("Duo WebAuthn factor not found at the prompt — falling back to manual Duo.");
    await finishDuoWebAuthn(page);
    return undefined;
  }

  return {
    factorLabel,
    // `approved` is informational; persistence + teardown happen unconditionally
    // in finishDuoWebAuthn (see its doc — the counter must stay ahead of Duo).
    finish: async (_opts) => {
      await finishDuoWebAuthn(page);
    },
  };
}
