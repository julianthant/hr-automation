import { readFileSync, writeFileSync } from "node:fs";
import type { CDPSession, Page } from "playwright";
import { launchBrowser, gotoWithRetry } from "../../infra/browser/launch.js";
import { fillSsoCredentials, clickSsoSubmit } from "../../infra/auth/sso-fields.js";
import { pollDuoApproval } from "../../infra/auth/duo-poll.js";
import {
  DUO_WEBAUTHN_CREDENTIAL_PATH,
  ctap2SupportShim,
  mergeDuoWebAuthnCredential,
  parseDuoWebAuthnCredentials,
  type DuoWebAuthnCredential,
  type DuoWebAuthnTransport,
} from "../../infra/auth/duo-webauthn.js";
import { log } from "../../utils/log.js";
import { isMainModule } from "../main-module.js";

/**
 * One-time enrollment of a CDP virtual authenticator as an independent Duo
 * security key, for hands-off Duo MFA at runtime.
 *
 * What it does:
 *  1. Launches Chromium and signs into `duo.ucsd.edu` (UCSD SSO).
 *  2. Completes the FIRST Duo manually — the operator approves once on their
 *     phone (a fresh machine has no credential to auto-assert with yet).
 *  3. On the Duo device-management portal, adds a new device by driving the
 *     "Add a device → Touch ID" (or Security key) flow. A CDP virtual
 *     authenticator answers the WebAuthn registration ceremony automatically.
 *  4. Exports the freshly-created credential (incl. its private key) and writes
 *     it to `.auth/duo-webauthn.json` (gitignored).
 *
 * After this, set `HR_AUTOMATION_DUO_WEBAUTHN=1` and every login flow approves
 * Duo via the virtual authenticator with no phone push (see
 * `src/infra/auth/duo-webauthn.ts`). Re-run only to rotate the key or enroll on
 * a new machine. Chromium-only.
 *
 * Usage:
 *   tsx --env-file=.env src/scripts/ops/duo-webauthn-enroll.ts [--security-key] [--name "<label>"] [--out <path>]
 */

const DUO_PORTAL_URL = "https://duo.ucsd.edu";
const DEVICE_MGMT_MATCH = "devicemanagement.duosecurity.com";
const DUO_RP_ID = "duosecurity.com";

export interface EnrollOptions {
  transport: DuoWebAuthnTransport;
  deviceName: string;
  out: string;
}

/** Parse CLI argv into enrollment options. Pure — exported for tests. */
export function parseEnrollArgs(argv: string[]): EnrollOptions {
  const flagValue = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : undefined;
  };
  return {
    transport: argv.includes("--security-key") ? "usb" : "internal",
    deviceName: flagValue("--name") ?? "HR Automation (Chrome)",
    out: flagValue("--out") ?? DUO_WEBAUTHN_CREDENTIAL_PATH,
  };
}

/** The Duo "Add a device" tile / prompt factor label to target per transport. */
function deviceTypePattern(transport: DuoWebAuthnTransport): RegExp {
  return transport === "usb" ? /security key/i : /touch id/i;
}

/** Click the first visible link/button/text matching any pattern. Returns what matched, or undefined. */
async function clickFirst(page: Page, patterns: RegExp[], timeoutMs = 8_000): Promise<string | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const re of patterns) {
      const target = page
        .getByRole("link", { name: re })
        .or(page.getByRole("button", { name: re }))
        .first();
      if ((await target.count().catch(() => 0)) > 0) {
        const label = (await target.innerText().catch(() => "")).split("\n")[0]?.trim() || re.source;
        await target.click({ timeout: 5_000 }).catch(() => {});
        return label;
      }
    }
    await page.waitForTimeout(500);
  }
  return undefined;
}

interface CdpCredential {
  credentialId: string;
  isResidentCredential?: boolean;
  rpId?: string;
  privateKey: string;
  userHandle?: string;
  signCount?: number;
}

async function setupVirtualAuthenticator(cdp: CDPSession, transport: DuoWebAuthnTransport): Promise<string> {
  // Clear any dangling authenticator first (one `internal` per environment).
  await cdp.send("WebAuthn.enable").catch(() => {});
  await cdp.send("WebAuthn.disable").catch(() => {});
  await cdp.send("WebAuthn.enable");
  const addOnce = async () =>
    (
      (await cdp.send("WebAuthn.addVirtualAuthenticator", {
        options: {
          protocol: "ctap2",
          transport,
          hasResidentKey: true,
          hasUserVerification: true,
          isUserVerified: true,
          automaticPresenceSimulation: true,
        },
      })) as { authenticatorId: string }
    ).authenticatorId;
  try {
    return await addOnce();
  } catch {
    await cdp.send("WebAuthn.disable").catch(() => {});
    await cdp.send("WebAuthn.enable").catch(() => {});
    return await addOnce();
  }
}

/** Poll the authenticator until a credential appears (the registration ceremony completed). */
async function awaitCreatedCredential(
  cdp: CDPSession,
  authenticatorId: string,
  page: Page,
  timeoutMs = 30_000,
): Promise<CdpCredential | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { credentials } = (await cdp.send("WebAuthn.getCredentials", { authenticatorId })) as {
      credentials: CdpCredential[];
    };
    if (credentials.length > 0) return credentials[credentials.length - 1];
    await page.waitForTimeout(1_000);
  }
  return undefined;
}

export async function enrollDuoWebAuthn(opts: EnrollOptions): Promise<DuoWebAuthnCredential> {
  log.step(`Duo WebAuthn enrollment starting (transport=${opts.transport}, name="${opts.deviceName}")`);
  const { browser, context, page } = await launchBrowser();
  try {
    // Duo gates the "Add Security key" tile behind
    // `isExternalCTAP2SecurityKeySupported`, absent in Playwright Chromium —
    // shim it true before the portal scripts run so the tile is offered.
    if (opts.transport === "usb") {
      await page.addInitScript(ctap2SupportShim).catch(() => {});
    }

    log.step(`Navigating to ${DUO_PORTAL_URL} ...`);
    await gotoWithRetry(page, DUO_PORTAL_URL);
    await fillSsoCredentials(page);
    await clickSsoSubmit(page);

    // The enrollment login has no working hands-off credential yet, so the first
    // Duo must be approved on the phone. Duo's portal prompt defaults to a
    // platform-auth ("Use Touch ID") screen that does NOT self-send a push — and
    // its native OS dialog can hide the factor text from the DOM, so the poll
    // loop's factor-screen auto-push never fires and nothing reaches the phone.
    // Proactively reveal the method list and send a Duo Push (fire-once) so the
    // operator only has to tap approve. Best-effort: if the controls aren't found,
    // the operator can still complete the visible prompt by hand.
    let pushSent = false;
    let revealedOptions = false;
    const pushControl = (): ReturnType<Page["getByRole"]> =>
      page
        .getByRole("link", { name: /duo push|send me a push/i })
        .or(page.getByRole("button", { name: /duo push|send me a push/i }))
        .first();
    const sendDuoPushOnce = async (): Promise<void> => {
      if (pushSent) return;
      try {
        if ((await pushControl().count().catch(() => 0)) > 0) {
          await pushControl().click({ timeout: 5_000 }).catch(() => {});
          pushSent = true;
          log.waiting("Duo Push sent for enrollment — approve on your phone...");
          return;
        }
        if (!revealedOptions) {
          // Dismiss a possible native platform-auth dialog that blocks DOM clicks,
          // then open the full "Other options" method list.
          await page.keyboard.press("Escape").catch(() => {});
          const other = page
            .getByRole("link", { name: /other options|other methods/i })
            .or(page.getByRole("button", { name: /other options|other methods/i }))
            .first();
          if ((await other.count().catch(() => 0)) > 0) {
            await other.click({ timeout: 3_000 }).catch(() => {});
            revealedOptions = true;
            // Let the list render before the next pass clicks Duo Push — clicking
            // mid-navigation lands Duo on an /error page.
            await page.waitForTimeout(1_500);
          }
        }
      } catch {
        /* best-effort — operator can still complete the prompt by hand */
      }
    };

    log.waiting("Approve the FIRST Duo on your phone — needed once to reach the device portal...");
    const reachedPortal = await pollDuoApproval(page, {
      successUrlMatch: DEVICE_MGMT_MATCH,
      systemLabel: "Duo Enrollment",
      timeoutSeconds: 300,
      recovery: sendDuoPushOnce,
    });
    if (!reachedPortal) {
      throw new Error("Did not reach the Duo device-management portal after SSO/Duo.");
    }
    log.step("On the Duo device-management portal.");

    const cdp = await context.newCDPSession(page);
    const authenticatorId = await setupVirtualAuthenticator(cdp, opts.transport);
    log.step(`Virtual authenticator ready (${opts.transport}). Driving "Add a device"...`);

    const addClicked = await clickFirst(page, [/add (a )?device/i, /add another device/i]);
    log.step(`Clicked: ${addClicked ?? "(add-device control not found — complete in browser)"}`);
    await page.waitForTimeout(1_500);

    const typeClicked = await clickFirst(page, [deviceTypePattern(opts.transport)]);
    log.step(`Selected device type: ${typeClicked ?? "(not found — select it in the browser window)"}`);
    // The registration ceremony fires here; the virtual authenticator answers it.

    // Name + confirm (best-effort — Duo finalizes server-side once create() resolves).
    await page.waitForTimeout(2_500);
    const nameField = page
      .getByRole("textbox")
      .or(page.locator('input[type="text"]'))
      .first();
    if ((await nameField.count().catch(() => 0)) > 0) {
      await nameField.fill(opts.deviceName, { timeout: 5_000 }).catch(() => {});
      log.step(`Named the device "${opts.deviceName}".`);
    }
    await clickFirst(page, [/continue|save|add device|finish|done|next/i], 6_000);

    log.step("Waiting for the registration ceremony to complete...");
    const created = await awaitCreatedCredential(cdp, authenticatorId, page);
    if (!created) {
      throw new Error(
        "No credential was created. The add-device UI may not have triggered the WebAuthn ceremony — re-run and complete the on-screen steps in the browser window.",
      );
    }

    const credential: DuoWebAuthnCredential = {
      rpId: created.rpId ?? DUO_RP_ID,
      credentialId: created.credentialId,
      privateKey: created.privateKey,
      ...(created.userHandle ? { userHandle: created.userHandle } : {}),
      signCount: created.signCount ?? 0,
      isResidentCredential: created.isResidentCredential ?? false,
      transport: opts.transport,
      enrolledAt: new Date().toISOString().slice(0, 10),
    };

    // Merge into any existing credentials (keyed by transport) rather than
    // overwrite — a machine may hold both a Touch ID and a Security key device.
    let existing: DuoWebAuthnCredential[] = [];
    try {
      existing = parseDuoWebAuthnCredentials(JSON.parse(readFileSync(opts.out, "utf8")));
    } catch {
      /* no prior file (or unreadable) — start fresh */
    }
    const credentials = mergeDuoWebAuthnCredential(existing, credential);
    writeFileSync(opts.out, `${JSON.stringify({ credentials }, null, 2)}\n`, "utf8");
    log.success(
      `Enrolled. Credential ${credential.credentialId.slice(0, 12)}… (${opts.transport}) written to ${opts.out} ` +
        `(${credentials.length} device${credentials.length === 1 ? "" : "s"} total). ` +
        `Set HR_AUTOMATION_DUO_WEBAUTHN=1 to enable hands-off Duo.`,
    );
    return credential;
  } finally {
    await context.close().catch(() => {});
    await browser?.close().catch(() => {});
  }
}

async function main(): Promise<void> {
  const opts = parseEnrollArgs(process.argv.slice(2));
  try {
    await enrollDuoWebAuthn(opts);
  } catch (err) {
    log.error(`Duo WebAuthn enrollment failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  }
}

if (isMainModule(import.meta.url)) {
  void main();
}
