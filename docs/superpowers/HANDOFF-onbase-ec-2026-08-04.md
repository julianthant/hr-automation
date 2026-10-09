# HANDOFF — OnBase Emergency Contact bulk import (2026-08-04)

## Paste-ready prompt for the next session

> Continue the OnBase Emergency Contact import. Read
> `docs/superpowers/HANDOFF-onbase-ec-2026-08-04.md` first — it has the completed
> transcriptions, the exact scripts, and the verification method. Batches 1–4
> (216 pages) are DONE. Five new PDFs (257 pages) are in progress: PDF 140534 and
> 140631 are transcribed (tables in the handoff); 140410, 140440 and 140602 still
> need reading. Do NOT delegate to the OCR workflow — read the pages directly.

---

## 1. What is already finished (do not redo)

**Batches 1–4 — 210 of 216 pages imported to OnBase, all verified.**

| PDF | pages | imported | pdfFileId (registered) |
|---|---|---|---|
| `Xerox Scan_07282026135349.pdf` | 47 | 44 | `d8b5d7b0-dbe1-4900-b084-c803f83a5de4` |
| `Xerox Scan_08042026084430.pdf` | 71 | 70 | `616cc816-be16-49f5-886f-620c548240b8` |
| `Xerox Scan_08042026102106.pdf` | 32 | 31 | `b3cfe775-f144-4a91-9b39-938673c90e02` |
| `Xerox Scan_08042026102133.pdf` | 66 | 65 | `106660c8-da28-4640-b9be-4d93f26fae8e` |

The 6 not imported are all deliberate: b1 p11 (DMV form), b1 p12 (blank),
b1 p37 / b2 p19 / b3 p11 (older duplicates — newest-only rule), b4 p11
(Person 1416, offer rescinded — operator said drop).

Note: `Xerox Scan_07282026135349.pdf` has been REMOVED from the project root.
That is fine — imports resolve from the content-addressed blob store
(`.tracker/blobs/`), not the original path.

---

## 2. The 5 new PDFs

| PDF | pages | transcription | lookups |
|---|---|---|---|
| `Xerox Scan_08042026140410.pdf` | 84 | **NOT DONE** | not started |
| `Xerox Scan_08042026140440.pdf` | 37 | **NOT DONE** | not started |
| `Xerox Scan_08042026140534.pdf` | 31 | DONE (§5) | **31 queued, results not yet read** |
| `Xerox Scan_08042026140602.pdf` | 56 | **NOT DONE** | not started |
| `Xerox Scan_08042026140631.pdf` | 49 | DONE (§6) | not started |

None of the 5 are registered as files yet — `registerLocalFile` at import time
(see §8) and record the returned `pdfFileId`.

**20 person-lookup daemons were spawned and authenticated.** They may still be
alive; check `ps aux | grep -c '[p]erson-lookup'`. If dead, respawn (§8).

**PDF 140534's 31 lookups were queued but their results were never read.**
First thing to do: harvest them (§8 "harvest lookups").

---

## 3. The method (this is what produced 210/216 correctly)

For each PDF:

1. **Render** the identity block of every page at 200 DPI:
   `pdftoppm -r 200 -png -x 0 -y 0 -W 1700 -H 1150 "<pdf>" <dir>/c`
2. **Read every page** with the Read tool. Extract name, Employee ID#, PID#,
   campus-email local-part, annotations.
3. **Two-stage verification — this is the load-bearing step:**
   - pages with a BLANK/malformed EID → person-lookup **by name**
   - pages WITH an EID → person-lookup **by EID** ("who owns this id?"), then
     compare the returned name to the name on the form
4. **Import** only pages whose EID is verified. Hold the rest.
5. **Retry** contention failures serially (§7).

### Why stage 3b matters

Across 216 forms, **10 carried a wrong EID**. Four of them pointed at a **real,
different employee** — each off by exactly ONE digit, each a valid 8-digit ID
that OnBase would have accepted while reporting success:

| form | wrong EID | actually belongs to | real EID |
|---|---|---|---|
| Person 255 | 10090157 | Person 2019 | 10090159 |
| Lucero Simaruz | 10090292 | Sanez Simaruz | 10090291 |
| Person 1096 | 10090276 | Kaeyaa Sane | 10090278 |
| Person 1685 | 10090182 | Kurumi Nakamura | 10090183 |

Without the EID-mode check these four file silently onto the wrong person.

---

## 4. Hard-won rules — read before transcribing

1. **A name-search "Not found" is usually a MISREAD FIRST NAME, not a missing
   record.** Every single "not found" in 216 forms turned out to be a
   transcription error. Confirmed cases: `Mekus`→**Merav** Posoc,
   `Dogan`→**Dogen** Shiota, `Pina`→**Piña** Contreras (the accent is
   load-bearing), `Schaever`→**Samubasu**.
   → Re-render the name line at 450 DPI before declaring anyone unresolvable:
   `pdftoppm -r 450 -png -f <P> -l <P> -x 900 -y 1290 -W 2600 -H 260 "<pdf>" nm<P>`
2. **A handwritten campus email can CONTRADICT a name read but never CONFIRM
   it.** Same hand ⇒ same letterform ambiguity. I misread `r` as `v` in BOTH
   Samubasu's name and his email, then called the email corroboration. It was
   circular. Independent = typed by someone else (CRM, UCPath, a roster).
3. **An EID-mode "Not found" can be a FALSE NEGATIVE.** Aocaro Romag'
   10090049 returned "Not found" by EID but a name search returned that exact
   EID (`Romag-Gofuk, Aocaro`). Re-run every negative once before trusting it.
4. **Compound surnames defeat the naive `First Last` → `Last, First` flip.**
   `fixture033@example.edu` revealed the surname was *Simaruz Huravadiw*.
   Derive the search key from the email local-part when the flip fails.
5. **CRM overrides date/department heuristics.** For Person 140 I argued for
   10090148 from start-date proximity; CRM said **10090155**. CRM won.
6. **Never guess a digit.** A 7-digit EID or one with a leading `0` is a dropped
   digit — look it up by name, don't reconstruct it.
7. **Completion check = per-page diff, not prose.** I lost track of one page
   (Euzife Rosales) by reconciling counts in text. Always run the §8
   "missing pages" query as the gate.

---

## 5. PDF 140534 (31pp) — TRANSCRIBED

```
page | name | eid | pid | email | notes
1 | Pakum Vazavut | - | A17122390 | pivazquez | EID BLANK
2 | Xitlaly Vazavut Guerrero | 10090237 | A18406708 | xcvazquezgue?rero |
3 | Eafel Vogo | - | A17926543 | e3vega | EID BLANK
4 | German Vogo | 10090262 | A19131143 | - |
5 | Valerie Vogo | 10090280 | A17985550 | v4vega | EID digits 6-8 OVERWRITTEN, low conf
6 | Laisha P. Velazquez | 10090212 | A18529364 | l3velazquez |
7 | Hotod Vosituroda | - | A17479221 | hvermillion | EID BLANK
8 | Person 1457 | 10090213 | A18524768 | mavetus |
9 | Person 2027 | 10090294 | A18754059 | vvidrialeszavate | name/email surname DISAGREE
10 | Kaylin M. Villa | - | A17408816 | k2villa | EID BLANK
11 | Difevuv Veruburina | - | A17840695 | dvillagrana | EID BLANK
12 | Vutizro Vebotidate | - | A16511261 | vvillalo | EID BLANK
13 | Aocaro Villalva | 10090203 | A18342768 | avillalva |
14 | Jezoziw Villani | 10090210 | A17413340 | juvillani |
15 | Person 928 | 10090282 | A19184891 | jav013 |
16 | Nokivi Valdez | 10090179 | A17897174 | N1Valdez |
17 | Allen Vuticuro | - | AV17762948 | A9valencia | EID BLANK; PID MALFORMED
18 | Eunep A. Vuticuro | 10090178 | A17475595 | - |
19 | Eunep A. Vuticuro | - | - | - | *** DMV Employer Pull Notice, NOT an EC form ***
20 | Eolused Vakovinobi | - | A17761038 | esvalenzuela | EID BLANK
21 | Juan Vakovinobi Burgos | 10090272 | A18852994 | - | name LOW CONFIDENCE (cursive)
22 | Shaila Tamar Vakovinobi Rojo | 10090198 | A78362378 | svalenzuelarojo |
23 | Jufiki Valerio | 10090277 | A18332504 | JValerio |
24 | Sowose Vefikibi | 10090245 | A17737513 | svaliente | EID 7th digit OVERWRITTEN
25 | Eutep Vupa | 1840309 | A18276569 | edvang | *** EID MALFORMED: 7 digits, no leading 10 ***
26 | Person 26 | 10090264 | A18735786 | advannarath |
27 | Person 1568 | 10090270 | A18933825 | n3vargas |
28 | Soveromo Vargas | 10090266 | A18372151 | s9vargas |
29 | Person 1620 | 10090172 | A69027876 | nvasant |
30 | Any Vavavut | - | A17794137 | - | EID BLANK; reads "Any" not "Amy"
31 | Person 898 | 10090238 | A18720029 | j2vaughan |
```

**Exclude:** p19 (DMV form; p18 is Eunep Vuticuro's real EC form — import p18).
**Two alphabetical runs:** p1–15 Vazavut→Villanueva, p16–31 restarts at Valdez.
**Lookups queued (results NOT yet harvested):** names — Vazavut Pakum, Vogo Eafel,
Vosituroda Hotod, Villa Kaylin M, Veruburina Difevuv, Vebotidate Vutizro,
Vuticuro Allen, Vakovinobi Eolused, Vupa Eutep, Vavavut Any, Vavavut Amy.
EIDs — the 20 listed above.

---

## 6. PDF 140631 (49pp) — TRANSCRIBED

```
page | name | eid | pid | email | notes
1 | Rogewa Walkup | 10090177 | A17649663 | rgwalkup |
2 | Jian Ren Francesco Witi | 10090259 | A19117100 | frw001 |
3 | Kitong Witi | 10090232 | A18021016 | yiw235 | NAME/EMAIL CONFLICT (yiw→Yitong?)
4 | Luthien Witi | 10090283 | A18785501 | luw039 |
5 | Ryan Witi | 10090211 | A18427425 | ryw007 |
6 | Shiran Witi | 10090265 | A18936558 | shw190 |
7 | Shuran Witi | 10090284 | A18740922 | elw022 | NAME/EMAIL CONFLICT
8 | Yvonne Witi | 10090260 | A18498681 | - |
9 | Person 943 | 10090195 | A17986752 | jrwarren |
10 | Mitsum Watanabe | 10090205 | A69036536 | miwatanabe |
11 | Person 697 | 10090215 | A19227535 | - | dated 10/30 — DUP with p12
12 | Person 697 | 10090215 | A19227535 | nwatanaharuetai | dated 2/11 — NEWER
13 | Person 359 | 10090285 | A18240003 | cwaysz |
14 | Jeffrey Waz | 10090267 | A18935941 | jew087 |
15 | Bri Wirar | - | A17680518 | brwelch | EID BLANK (personal: fixture012@example.edu)
16 | Ruwem Wen | 10090180 | - | renen | HDH-HR variant, no PID
17 | Eicofotuz Werley | 10090252 | A19139575 | eawerley |
18 | Mozoz Wukizuw | - | A17836965 | mwhatley | EID BLANK
19 | Person 121 | 10090218 | A18234279 | agwignall |
20 | Person 1374 | 10090244 | A18749132 | kwikert |
21 | Miba Wilcox | 10090231 | A18536364 | mhwilcox |
22 | Person 1883 | 10090158 | A17493003 | swilhelmy |
23 | Kele Wonzzzevi Jr. | - | A17411138 | kdwilkerson | EID BLANK
24 | Aogime Wusubudi | 10090092 | A53242287 | - | email line holds SUPERVISOR's
25 | Avery Wusubudi | 10090188 | A59026018 | avwilliams | @health.ucsd.edu
26 | Jadon Wusubudi | 10090242 | A19080378 | jkw011 |
27 | Nevia Wusubudi | 10090165 | A17298517 | n3williams |
28 | Alyana N. Wonevi | 10090200 | A17737550 | alw032 |
29 | Soveromo Wonevi | 1076?943 | A18218300 | - | *** EID 5th char AMBIGUOUS — look up by name ***
30 | Rena Rose Witkin | 10090224 | A17800779 | - |
31 | Thomas J Woods | 10090243 | A78669477 | tgwoods |
32 | Person 565 | 10090257 | A18792434 | d5wen | out of sequence
33 | Chloe Wefu | 10090233 | A18381788 | cjw018 |
34 | Kasey Wefu | 10090256 | A18922958 | - |
35 | Aocaro Wz | 10090241 | A18513839 | - |
36 | Boxiao Wz | 10090251 | A19087912 | bow023 |
37 | Dennis Wz | 10090184 | - | dcwu | HDH-HR variant, no PID
38 | Jianxi Wz | 10090261 | A18781813 | - |
39 | Sixian Wz | 10090258 | A18938709 | naw012 | NAME/EMAIL CONFLICT (fixture040@example.edu)
40 | Mina Itzel Villanueva | 10090235 | A18799025 | m9villanueva |
41 | Person 215 | 10090164 | - | arvillarreal | HDH-HR variant, no PID
42 | Eecozozu Vevuz | - | A17454516 | eviray | TYPED form; EID BLANK
43 | Kocew Vz | 10090254 | A18554065 | khv007 |
44 | Person 808 | - | A17292498 | h4vu | EID BLANK
45 | Person 842 | 10090269 | A18273156 | isvue |
46 | Person 2148 | 10090263 | A18705424 | yevue |
47 | Vanessa Valentina Vuong | 10090208 | A18303514 | - |
48 | Amy Vz | 10090199 | A17670796 | - | out of sequence
49 | Aidetupa Ueguba | 10090216 | A18512329 | - | U surname, filed last
```

**Duplicate:** p11/p12 same person, same EID — **import p12 (2/11, newer), skip p11.**
**Name lookups needed:** p15 Wirar Bri, p18 Wukizuw Mozoz, p23 Wonzzzevi Kele,
p29 Wonevi Soveromo (ambiguous EID), p42 Vevuz Eecozozu, p44 Vu Henry.
**EID verifications needed:** all other pages' EIDs (42 of them).
**Watch:** p3/p7/p39 name-vs-email conflicts — verify by EID and trust the
UCPath-returned name, not the email.

---

## 7. Known operational gotchas

- **OnBase allows ONE app session per identity.** 8-parallel import works but
  loses ~25% to session contention; those all fail at `authenticate` or
  `prepare-import` with `keysetAutofilled` unset — meaning **nothing was
  committed, so retrying cannot duplicate**. Always check the failed step before
  retrying. Clean up with `parallel: 1, new: true` after
  `npm run onbase:stop` (wait ~20s for stale server-side sessions to lapse).
- **person-lookup scales fine to 20 daemons** (different system, no contention).
- **Network drops look like data problems.** A 2026-08-04 outage turned 8 lookups
  into "Error" and one into a false "Not found". Check for
  `ERR_CONNECTION_CLOSED` / `ERR_INTERNET_DISCONNECTED` in
  `.tracker/logs/person-lookup-*.jsonl` before believing a negative.
- **Deleting a queue row needs an operator token** and there may be MULTIPLE
  runIds per id — delete each (see §8).
- **Every legacy `src/` or `tests/` commit must be accounted** in
  `config/rebuild/legacy-change-accounting.json` (this repo, D90 manifest) —
  refresh `afterSha256`, then `npx vitest run
  tests/unit/architecture/legacy-change-accounting.test.ts`.

---

## 8. Commands / snippets

```bash
# spawn N person-lookup daemons (script pattern)
#   spawnDaemon/findAliveDaemons from src/core/daemon/registry.js, loop to TARGET

# harvest lookup results (name-mode and EID-mode)
python3 -c "
import json
for line in open('.tracker/rows/person-lookup-2026-08-04.jsonl'):
    try: e=json.loads(line)
    except: continue
    if e.get('status')!='done': continue
    d=e.get('data',{})
    print(e.get('id'),'|',d.get('searchName'),'->',d.get('emplId') or d.get('matchedEmplId'),'|',d.get('resolvedName'),'|',d.get('hrStatus'))
" | sort -u

# WHICH PAGES ARE MISSING  <-- use this as the completion gate
python3 -c "
import json,collections
imp=collections.defaultdict(set)
for line in open('.tracker/rows/onbase-2026-08-04.jsonl'):
    try: e=json.loads(line)
    except: continue
    d=e.get('data',{}); pdf=d.get('pdfOriginalName') or ''
    if pdf and e.get('status')=='done' and d.get('sourcePage'): imp[pdf].add(int(d['sourcePage']))
TOT={'<pdf name>':<pages>}
for pdf,n in TOT.items():
    got=imp.get(pdf,set()); print(pdf, len(got),'/',n,'missing',sorted(set(range(1,n+1))-got))
"

# delete a stale queue row (ALL runIds for the id)
TOK=$(curl -s http://localhost:3939/api/operator/session | python3 -c "import sys,json;print(json.load(sys.stdin)['token'])")
curl -s -X POST http://localhost:3939/api/delete-entry -H 'Content-Type: application/json' \
  -H "x-hr-auto-operator-token: $TOK" \
  -d '{"workflow":"onbase","id":"<eid>","runId":"<runId>","date":"2026-08-04","source":"queue"}'

npm run onbase:stop
npm run person-lookup:stop
npm run dashboard:prod -- --port 3939     # 3838/5173 belong to the rebuild repo
```

### Import script shape

```ts
import { registerLocalFile } from "../../src/tracker/files/files.js";
import { openControlDb } from "../../src/core/control-db.js";
import { PATHS } from "../../src/config.js";
import { runOnbaseCli } from "../../src/workflows/onbase/workflow.js";
import { ONBASE_EC_DOCUMENT_TYPE, ONBASE_EC_DOCUMENT_NAME } from "../../src/systems/onbase/index.js";

const control = openControlDb({});
const reg = registerLocalFile(control.db, {
  trackerDir: PATHS.trackerDir, kind: "pdf", mimeType: "application/pdf",
  path: resolve(FILE), originalName: FILE, source: "manual-onbase-run", workflow: "onbase",
});
control.close();

const inputs = rows.map(([page, name, eid]) => ({
  ucpathId: eid, sourcePage: page, pdfFileId: reg.fileId, pdfOriginalName: FILE,
  documentType: ONBASE_EC_DOCUMENT_TYPE, documentName: ONBASE_EC_DOCUMENT_NAME,
  employeeName: name,
}));
await runOnbaseCli(inputs, { parallel: 8 });
```

EID-mode lookups need `ensureDaemonsAndEnqueue(personLookupWorkflow,
[{emplId}], {}, { deriveItemId: derivePersonLookupItemId })` — `runPersonLookupCli`
only builds `{name}` inputs.

**Success proof for every imported row:** `data.keysetAutofilled === "true"` AND
`data.status === "Imported"`.

---

## 9. Immediate next steps

1. Harvest PDF 140534's 31 queued lookups (§8), cross-check, import the clean set.
2. Cross-check + import PDF 140631 using §6 (queue its 6 name + 42 EID lookups).
3. Read PDFs **140410 (84pp)**, **140440 (37pp)**, **140602 (56pp)** — subagents
   worked well; the reader prompt is reproduced in §10.
4. Retry contention failures serially; run the §8 missing-pages gate before
   declaring done.

---

## 10. Reader subagent prompt (reuse verbatim, swap pdf/pages/dir)

> Read every page of ONE PDF and return a transcription table. Do NOT import, do
> NOT run person-lookup. Your ONLY job is accurate transcription.
> PDF: `<path>` — `<N>` pages. UCSD Emergency Contact forms, one person per page,
> roughly alphabetical, three layout variants (HDH, RRSCS, HDH-HR).
> Render: `pdftoppm -r 200 -png -x 0 -y 0 -W 1700 -H 1150 "<pdf>" <dir>/c`
> Read EVERY crop (batch ~6/message). Per page extract: Employee Name,
> Employee ID# (8 digits starting 10), PID# (A########), campus-email local-part,
> annotations.
> **If a name is not crystal clear at 200 DPI, re-render THAT name line at 450 DPI**
> (`-f <P> -l <P> -x 900 -y 1290 -W 2600 -H 260`) and re-read.
> **Preserve accents exactly** (`Piña` not `Pina`). **Never normalise or guess a
> digit** — write `?` for an ambiguous character. A campus email is the SAME
> handwriting so it can contradict but never confirm a name.
> Flag: blank/malformed EIDs, non-EC documents, blank pages, same person on two
> pages (give both page numbers + dates), out-of-sequence pages, annotations.
> Return ONLY the table `page | name | eid | pid | email | notes` then a FLAGS
> section, then `TOTAL PAGES READ: <n>`.

---

## 11. BATCH 5 COMPLETE (2026-08-04 evening session)

**251/251 importable pages imported** (of 257 total; 6 deliberate skips).

| PDF | pages | imported | skips | pdfFileId |
|---|---|---|---|---|
| `Xerox Scan_08042026140534.pdf` | 31 | 30 | p19 DMV | `073e49b5-840a-4f20-9ce3-d8e35b6c8bfe` |
| `Xerox Scan_08042026140631.pdf` | 49 | 48 | p11 older dup | `e5f675d7-dfc1-4932-b344-0a316bfaa959` |
| `Xerox Scan_08042026140440.pdf` | 37 | 36 | p18 Kafunil Token Not found | `0360212e-f668-4e51-8181-b9efe7eba1c4` |
| `Xerox Scan_08042026140602.pdf` | 56 | 56 | — | `d3c6dba7-bb39-4772-b8e4-fd932f9ae268` |
| `Xerox Scan_08042026140410.pdf` | 84 | 81 | p25/58/64 older dups | `73d4400a-98cd-4e05-b833-d2df19818213` |

### Wrong EIDs caught by EID-mode verification this batch
| form | wrong EID | actually belongs to | real EID |
|---|---|---|---|
| Person 2026 (140534 p9) | 10090294 (misread 4 as 9) | Sergio Datugan | **10090286** |
| Person 614 (140440 p30) | 10090223 | Isa Green | **10090222** |
| Person 1541 (140602 p21) | 10090106 | Jarrod Hoogland | **10090110** |
| Eutep Towa (140410 p49) | 10090289 | Seweso Habib | **10090290** |

### Other notable resolutions
- Eutep Vupa form "1840309" → **10090246** (dropped leading 10)
- Person 1147 form "70090001" → **10090221**
- Mubos Sifarove overwritten EID → **10090271**
- Person 687 / Person 1700 → **10090163** (annot + EID)
- "Rintoy/Person 1761" → **Person 793 10090288**
- "Guogo Zine" → **Gogo Zine 10090253**
- "Liliana Zine-Zafiz" → **Zafiz, Liliana Zine 10090167**
- "Joson Towa" → **Jatib Towa 10090109** (a/o misread)
- Yo Yal ambiguous → **10090169** (Yal, Yo)
- Soveromo Wonevi ambiguous digit → **10090191**

### Permanent hold
- **Kafunil Token** (140440 p18): blank EID, Not found under Kafunil/Kristen/Kafunzl Token. PID A17409858, personal email fixture031@example.edu.

Transcriptions preserved in `scripts/.tmp/transcribe-*.md`.
