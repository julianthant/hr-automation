import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { randomUUID } from "crypto";
import { join } from "path";
import { tmpdir } from "os";
import { rmSync } from "fs";
import { log } from "../utils/log.js";
import type { TileLayout } from "./tiling.js";

export interface SessionWindowOptions {
  viewport?: { width: number; height: number };
  args?: string[];
}

export class WorkflowSession {
  private context: BrowserContext;
  private browser: Browser | null;
  private pages: Map<string, Page> = new Map();
  readonly sessionDir: string;

  private constructor(context: BrowserContext, browser: Browser | null, sessionDir: string) {
    this.context = context;
    this.browser = browser;
    this.sessionDir = sessionDir;
  }

  static async create(options?: SessionWindowOptions & { acceptDownloads?: boolean }): Promise<WorkflowSession> {
    const sessionDir = join(tmpdir(), `hr-auto-${randomUUID().slice(0, 8)}`);
    const context = await chromium.launchPersistentContext(sessionDir, {
      headless: false,
      viewport: options?.viewport ?? { width: 1920, height: 1080 },
      acceptDownloads: options?.acceptDownloads ?? false,
      args: options?.args,
    });
    const page = context.pages()[0] ?? (await context.newPage());
    const session = new WorkflowSession(context, null, sessionDir);
    session.pages.set("default", page);
    log.step(`Session created: ${sessionDir}`);
    return session;
  }

  static async createIsolated(options?: SessionWindowOptions & { acceptDownloads?: boolean }): Promise<WorkflowSession> {
    const browser = await chromium.launch({ headless: false, args: options?.args });
    const context = await browser.newContext({
      viewport: options?.viewport ?? { width: 1920, height: 1080 },
      acceptDownloads: options?.acceptDownloads ?? false,
    });
    const page = await context.newPage();
    const session = new WorkflowSession(context, browser, "");
    session.pages.set("default", page);
    return session;
  }

  get defaultPage(): Page { return this.pages.get("default")!; }

  async newWindow(name: string, options?: SessionWindowOptions): Promise<Page> {
    const page = await this.context.newPage();
    if (options?.viewport) await page.setViewportSize(options.viewport);
    this.pages.set(name, page);
    return page;
  }

  async newTiledWindow(name: string, tile: TileLayout): Promise<Page> {
    const page = await this.context.newPage();
    await page.setViewportSize(tile.viewport);
    this.pages.set(name, page);
    return page;
  }

  getWindow(name: string): Page | undefined { return this.pages.get(name); }

  get allPages(): Page[] { return [...this.pages.values()]; }

  async close(): Promise<void> {
    try {
      if (this.browser) await this.browser.close();
      else await this.context.close();
    } catch {}
    if (this.sessionDir) {
      try { rmSync(this.sessionDir, { recursive: true, force: true }); log.step(`Session cleaned up: ${this.sessionDir}`); } catch {}
    }
  }
}
