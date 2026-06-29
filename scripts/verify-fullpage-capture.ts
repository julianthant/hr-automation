/**
 * Verification harness for the scroll-and-capture `Session.captureFullPage`.
 *
 * Boots a REAL headless Chromium, loads fixtures that reproduce the two live
 * failure modes the operator saw — a fixed Kuali-style modal with its own inner
 * overflow + a sticky "unsupported browser" banner, and a UCPath-style
 * same-origin iframe whose content scrolls inside a short fixed-height box — plus
 * a plain tall window page and a short page, and runs the actual production
 * `Session.captureFullPage` against each. Writes the PNG slices under
 * `generated/.screenshot-verify/` so they can be eyeballed.
 *
 * Run: tsx scripts/verify-fullpage-capture.ts
 */
import { chromium } from 'playwright'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { Session } from '../src/core/kernel/session.js'

const OUT = join(process.cwd(), 'generated', '.screenshot-verify')

const KUALI = `<!doctype html><html><head><style>
  body { margin:0; font-family: system-ui, sans-serif; background:#eef; }
  .banner { position:fixed; top:0; left:0; right:0; height:36px; background:#3a2a00; color:#ffd; z-index:9999; display:flex; align-items:center; padding:0 12px; }
  .pagebehind { height:600px; padding:48px 16px 16px; }
  .pagebehind .tile { display:inline-block; width:120px; height:60px; background:#fc6; margin:6px; }
  .dialog { position:fixed; top:60px; left:50%; transform:translateX(-50%); width:760px; max-height:560px; overflow-y:auto; background:#fff; box-shadow:0 10px 40px rgba(0,0,0,.3); border-radius:8px; }
  .dialog .hdr { position:sticky; top:0; background:#fff; border-bottom:1px solid #ddd; padding:12px 16px; font-weight:600; }
  .row { padding:14px 18px; border-bottom:1px solid #eee; }
  .row label { display:block; font-size:12px; color:#555; }
  .row .v { font-size:15px; font-weight:600; }
</style></head><body>
  <div class="banner">It looks like you are using a browser that we do not support.</div>
  <div class="pagebehind"><b>Action List (behind)</b><br>
    ${Array.from({ length: 12 }).map(() => '<span class="tile"></span>').join('')}
  </div>
  <div class="dialog">
    <div class="hdr">4359 — Submitted Jun 24, 2026 · 2:47 PM · IN PROGRESS</div>
    ${Array.from({ length: 24 }).map((_, i) => `<div class="row"><label>Field ${i + 1} of 24 (TOP marker at #1, BOTTOM marker at #24)</label><div class="v">Value for separation field number ${i + 1}</div></div>`).join('')}
  </div>
</body></html>`

const UCPATH = `<!doctype html><html><head><style>
  body { margin:0; font-family: system-ui, sans-serif; }
  .topbar { height:64px; background:#1c6; color:#fff; display:flex; align-items:center; padding:0 16px; font-size:20px; }
  iframe { width:100%; height:520px; border:0; }
</style></head><body>
  <div class="topbar">UCPath — HR Tasks</div>
  <iframe srcdoc='${(`<!doctype html><html><head><style>
    body{margin:0;font-family:system-ui,sans-serif;padding:8px 16px;}
    .sec{border:1px solid #c93;margin:10px 0;}
    .sec h4{background:#fde9c8;color:#963;margin:0;padding:6px 10px;}
    .sec .b{padding:10px;}
    .fld{margin:6px 0;font-size:13px;}
  </style></head><body>
    ${Array.from({ length: 10 }).map((_, i) => `<div class="sec"><h4>Section ${i + 1}</h4><div class="b">${Array.from({ length: 4 }).map((__, j) => `<div class="fld">Field ${i + 1}.${j + 1}: lorem ipsum job data value</div>`).join('')}</div></div>`).join('')}
    <div class="fld" style="font-weight:700">Transaction ID: T002173413 (THIS IS THE LAST LINE — must be captured)</div>
  </body></html>`).replace(/'/g, '&#39;')}'></iframe>
</body></html>`

const TALL = `<!doctype html><html><head><style>
  body{margin:0;font-family:system-ui,sans-serif}
  .blk{height:280px;border-bottom:2px solid #333;display:flex;align-items:center;justify-content:center;font-size:40px}
</style></head><body>
  ${Array.from({ length: 11 }).map((_, i) => `<div class="blk" style="background:hsl(${i * 30},70%,85%)">Block ${i + 1} / 11</div>`).join('')}
</body></html>`

const SHORT = `<!doctype html><html><head><style>body{margin:0;font-family:system-ui;padding:24px}</style></head><body><h1>Short form</h1><p>Just a little content that fits one viewport.</p></body></html>`

async function run(): Promise<void> {
  await fs.rm(OUT, { recursive: true, force: true })
  await fs.mkdir(OUT, { recursive: true })
  const browser = await chromium.launch({ headless: true })
  const ctx = await browser.newContext({ viewport: { width: 1100, height: 800 } })
  const page = await ctx.newPage()

  const fixtures: Array<[string, string]> = [
    ['kuali-modal', KUALI],
    ['ucpath-iframe', UCPATH],
    ['tall-window', TALL],
    ['short', SHORT],
  ]
  for (const [name, html] of fixtures) {
    await page.setContent(html, { waitUntil: 'load' })
    await page.waitForTimeout(150)
    const base = join(OUT, `${name}.png`)
    const slicePath = (chunk: number | null): string =>
      chunk === null ? base : base.replace(/\.png$/, `-c${String(chunk + 1).padStart(2, '0')}.png`)
    const written = await Session.captureFullPage(page, slicePath)
    console.log(`\n[${name}] wrote ${written.length} file(s):`)
    for (const p of written) {
      const st = await fs.stat(p).catch(() => null)
      console.log(`  ${p}${st ? ` (${st.size} bytes)` : ' (MISSING)'}`)
    }
  }
  await browser.close()
  console.log(`\nDone → ${OUT}`)
}

run().catch((e) => { console.error(e); process.exit(1) })
