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
(name:7364f7bb6a7e927e, offer rescinded — operator said drop).

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
| name:3e4e9d649279a2f2 | id:6aaec654e2ba7b65 | name:8155d2fb7cc75301 | id:fe0088383f170a9c |
| name:b5d42184a0da84c0 | id:afabfb1309893b4f | Sarah Sanchez | id:fe53f915a8cdc155 |
| name:4528fcc3dc0d5a5e | id:7ef3eec987eb80e9 | Kaeyaa Sane | id:440bbba29e3269b8 |
| name:e34c0906eb959dd8 | id:5a951ee3810d1b8f | Kurumi Nakamura | id:acd4cf0921b9ebb3 |

Without the EID-mode check these four file silently onto the wrong person.

---

## 4. Hard-won rules — read before transcribing

1. **A name-search "Not found" is usually a MISREAD FIRST NAME, not a missing
   record.** Every single "not found" in 216 forms turned out to be a
   transcription error. Confirmed cases: `Megan`→**Merav** Price,
   `Dogan`→**Dogen** Shiota, `Pina`→**Piña** Contreras (the accent is
   load-bearing), `Schaever`→**Schaerer**.
   → Re-render the name line at 450 DPI before declaring anyone unresolvable:
   `pdftoppm -r 450 -png -f <P> -l <P> -x 900 -y 1290 -W 2600 -H 260 "<pdf>" nm<P>`
2. **A handwritten campus email can CONTRADICT a name read but never CONFIRM
   it.** Same hand ⇒ same letterform ambiguity. I misread `r` as `v` in BOTH
   Schaerer's name and his email, then called the email corroboration. It was
   circular. Independent = typed by someone else (CRM, UCPath, a roster).
3. **An EID-mode "Not found" can be a FALSE NEGATIVE.** name:7c8af28209d2b03c'
   id:84f0d11d6b6a5f1a returned "Not found" by EID but a name search returned that exact
   EID (`Reyes-Gomez, Andrew`). Re-run every negative once before trusting it.
4. **Compound surnames defeat the naive `First Last` → `Last, First` flip.**
   `ucsd:4762fabc08dc4768` revealed the surname was *Sanchez Hernandez*.
   Derive the search key from the email local-part when the flip fails.
5. **CRM overrides date/department heuristics.** For name:c06d03adc43f0638 I argued for
   id:2a8172d5e5154886 from start-date proximity; CRM said **id:b28868f07c8bfabb**. CRM won.
6. **Never guess a digit.** A 7-digit EID or one with a leading `0` is a dropped
   digit — look it up by name, don't reconstruct it.
7. **Completion check = per-page diff, not prose.** I lost track of one page
   (name:fab6caf73496f460) by reconciling counts in text. Always run the §8
   "missing pages" query as the gate.

---

## 5. PDF 140534 (31pp) — TRANSCRIBED

```
page | name | eid | pid | email | notes
1 | name:b1dd21c651192ea5 | - | A17122390 | pivazquez | EID BLANK
2 | name:cd1e353b3cd8e87d | id:27ba53d7629f76fb | A18406708 | xcvazquezgue?rero |
3 | name:6cbd3d575b4aca6c | - | A17926543 | e3vega | EID BLANK
4 | name:ea41fe8f6eba53cc | id:338a1c044f005ead | A19131143 | - |
5 | name:fe8674c728141779 | id:beb67e01413c6f13 | A17985550 | v4vega | EID digits 6-8 OVERWRITTEN, low conf
6 | Laisha P. Velazquez | id:b0e32eb5aaa92bd3 | A18529364 | l3velazquez |
7 | name:e5f6ae4c25f781b3 | - | A17479221 | hvermillion | EID BLANK
8 | name:74fa09f04daf6850 | id:2d5a60e35bb0790a | A18524768 | mavetus |
9 | name:d7cc91ed07948eb3 | id:1fd81b30f9aa2920 | A18754059 | vvidrialeszavate | name/email surname DISAGREE
10 | Kaylin M. Villa | - | A17408816 | k2villa | EID BLANK
11 | name:5444a6d8fa974a24 | - | A17840695 | dvillagrana | EID BLANK
12 | name:abdb43d62b69df96 | - | A16511261 | vvillalo | EID BLANK
13 | name:6c506dc77e6c535f | id:3043ae315a287ec9 | A18342768 | avillalva |
14 | name:2dccefd48e63ab77 | id:252cf3471b1c1497 | A17413340 | juvillani |
15 | name:93e19c01739ac8bb | id:b86bf70f720d1900 | A19184891 | jav013 |
16 | name:22bb7947ebf9c4c8 | id:4af41fa8838969f1 | A17897174 | N1Valdez |
17 | name:c36ff5444148b3c9 | - | AV17762948 | A9valencia | EID BLANK; PID MALFORMED
18 | Edgar A. Valencia | id:ed4977f432bb340d | A17475595 | - |
19 | Edgar A. Valencia | - | - | - | *** DMV Employer Pull Notice, NOT an EC form ***
20 | name:cd2ec5650aee83de | - | A17761038 | esvalenzuela | EID BLANK
21 | Juan Valenzuela Burgos | id:9f40c27fb6c0fd70 | A18852994 | - | name LOW CONFIDENCE (cursive)
22 | Shaila Tamar Valenzuela Rojo | id:f696c76391078a05 | A78362378 | svalenzuelarojo |
23 | name:04122d7a6dda1941 | id:70e4ea28ab797c3c | A18332504 | JValerio |
24 | Sophia Valiente | id:33d8b5ccf7cd414f | A17737513 | svaliente | EID 7th digit OVERWRITTEN
25 | name:31781010a30d7134 | 1840309 | A18276569 | edvang | *** EID MALFORMED: 7 digits, no leading 10 ***
26 | name:49c299a01cef1549 | id:c8a1752bf81c9e55 | A18735786 | advannarath |
27 | name:7f4ce887b1b8b2a8 | id:680a51a096c23320 | A18933825 | n3vargas |
28 | name:1cfff0db29f30b6c | id:d26ff54105e4ae5c | A18372151 | s9vargas |
29 | name:f158317eade94c75 | id:ee04425ffb201148 | A69027876 | nvasant |
30 | name:f833b4007da4a1e2 | - | A17794137 | - | EID BLANK; reads "Any" not "Amy"
31 | name:70dc83d6d6b5d9d9 | id:702d241d2ffba554 | A18720029 | j2vaughan |
```

**Exclude:** p19 (DMV form; p18 is name:e958bcce170eebfb's real EC form — import p18).
**Two alphabetical runs:** p1–15 Vazquez→Villanueva, p16–31 restarts at Valdez.
**Lookups queued (results NOT yet harvested):** names — Vazquez Paula, Vega Emily,
Vermillion Hazel, Villa Kaylin M, Villagrana Danitza, Villalobos Valeria,
Valencia Allen, Valenzuela Esteban, Vang Ethan, Vasquez Any, Vasquez Amy.
EIDs — the 20 listed above.

---

## 6. PDF 140631 (49pp) — TRANSCRIBED

```
page | name | eid | pid | email | notes
1 | name:d10c962c03a60e7e | id:d7a6fe8cf1b5808c | A17649663 | rgwalkup |
2 | Jian Ren name:3903782982b6a4a5 | id:d8aa98892e09e15e | A19117100 | frw001 |
3 | Kitong Wang | id:5d8f147bf55a67ff | A18021016 | yiw235 | NAME/EMAIL CONFLICT (yiw→Yitong?)
4 | name:efdf67175b482e15 | id:509b920dce4f37df | A18785501 | luw039 |
5 | name:4af90320ce08d7e7 | id:8ac34578f704b894 | A18427425 | ryw007 |
6 | name:56c0658a888aed6f | id:9363a753752944db | A18936558 | shw190 |
7 | Shuran Wang | id:6c92b34c1191efb4 | A18740922 | elw022 | NAME/EMAIL CONFLICT
8 | name:1bdadc4fa45f4ad8 | id:ae8af46f433c7cbf | A18498681 | - |
9 | name:a9cf45911f6c8225 | id:9b0266e12951dedd | A17986752 | jrwarren |
10 | Mitsum Watanabe | id:1242039082076fec | A69036536 | miwatanabe |
11 | name:d56cd9ba8269e707 | id:bc6905e92a5ffc22 | A19227535 | - | dated 10/30 — DUP with p12
12 | name:d56cd9ba8269e707 | id:bc6905e92a5ffc22 | A19227535 | nwatanaharuetai | dated 2/11 — NEWER
13 | name:5e63fab26f1965c2 | id:5e93643682f5e74e | A18240003 | cwaysz |
14 | name:aa02af7a6dccea6d | id:e2cccad4a19115c7 | A18935941 | jew087 |
15 | name:d215625532829706 | - | A17680518 | brwelch | EID BLANK (personal: briannawelch@gmail.com)
16 | name:1deab3294bf32945 | id:5a89e8a7f2a378fe | - | renen | HDH-HR variant, no PID
17 | name:5d467a3f24ec65aa | id:63182bee4ca380f9 | A19139575 | eawerley |
18 | name:d673983728ca6af5 | - | A17836965 | mwhatley | EID BLANK
19 | name:297f1917206314af | id:8741eb003e276702 | A18234279 | agwignall |
20 | name:496b0fa038776b13 | id:1c1914610c211889 | A18749132 | kwikert |
21 | name:2034f3fb0ad8c788 | id:479bd32637db3041 | A18536364 | mhwilcox |
22 | name:481d0a5bfda69dc0 | id:3b20ecfea27c0d13 | A17493003 | swilhelmy |
23 | name:5dd201561e14c61d. | - | A17411138 | kdwilkerson | EID BLANK
24 | name:15de6a6d32b73791 | id:a0f08c812769456f | A53242287 | - | email line holds SUPERVISOR's
25 | name:972502208909cdcd | id:69b7273cc92306ee | A59026018 | avwilliams | @health.ucsd.edu
26 | name:a2d2eaf61b73bdbe | id:ead99c413728ef24 | A19080378 | jkw011 |
27 | name:69085ceb8017db81 | id:dc9c09f7fcee675c | A17298517 | n3williams |
28 | Alyana N. Wilson | id:9f48dd1ec042e7e1 | A17737550 | alw032 |
29 | name:12a74f063e683226 | 1076?943 | A18218300 | - | *** EID 5th char AMBIGUOUS — look up by name ***
30 | Rena Rose Witkin | id:17d0f8638ee067ee | A17800779 | - |
31 | Thomas J Woods | id:e5467961b968493b | A78669477 | tgwoods |
32 | name:7aaabf3ca5d3a28c | id:ffacfe40e60ad626 | A18792434 | d5wen | out of sequence
33 | name:6ef7d98710dcc7be | id:1b5e4c340ca41c79 | A18381788 | cjw018 |
34 | name:076b2c7e1563534d | id:7155c7d4d5b8718d | A18922958 | - |
35 | name:7a31b3ae4e4c310d | id:8b4c4db652ec5d4b | A18513839 | - |
36 | name:99350e7a2efd5302 | id:c108c90bc35240b9 | A19087912 | bow023 |
37 | name:1d2c1295c127ca62 | id:90a57b9e2017d8b5 | - | dcwu | HDH-HR variant, no PID
38 | name:5ee4712a4938d954 | id:a69c564915dbd753 | A18781813 | - |
39 | Sixian Wu | id:304193a6c8eba5f9 | A18938709 | naw012 | NAME/EMAIL CONFLICT (nancywu0618@gmail.com)
40 | Mina Itzel Villanueva | id:aaa0047b3dea6f01 | A18799025 | m9villanueva |
41 | name:981446661eaf2d9a | id:8b0a397dd4cc6265 | - | arvillarreal | HDH-HR variant, no PID
42 | name:94cf8c495f0b748e | - | A17454516 | eviray | TYPED form; EID BLANK
43 | name:7c4dfef69009e52f | id:3c6648fa80011ea0 | A18554065 | khv007 |
44 | name:c9b226c86296b138 | - | A17292498 | h4vu | EID BLANK
45 | name:6465cfeb80265d55 | id:bf1c31061f2460c9 | A18273156 | isvue |
46 | name:b79eed31ce4fccb4 | id:7bde69f1b66383df | A18705424 | yevue |
47 | Vanessa Valentina Vuong | id:b7f0e59a4811a59b | A18303514 | - |
48 | name:4231e4a9508e8d35 | id:f9dee6df9bfe6ca8 | A17670796 | - | out of sequence
49 | Akitsugu Uchida | id:dc6ad4b4ae480116 | A18512329 | - | U surname, filed last
```

**Duplicate:** p11/p12 same person, same EID — **import p12 (2/11, newer), skip p11.**
**Name lookups needed:** p15 Welch Bri, p18 Whatley Monay, p23 Wilkerson Kurt,
p29 Wilson Samantha (ambiguous EID), p42 Viray Emmanuel, p44 Vu Henry.
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
| `Xerox Scan_08042026140440.pdf` | 37 | 36 | p18 name:4ee1ecca7f502f81 Not found | `0360212e-f668-4e51-8181-b9efe7eba1c4` |
| `Xerox Scan_08042026140602.pdf` | 56 | 56 | — | `d3c6dba7-bb39-4772-b8e4-fd932f9ae268` |
| `Xerox Scan_08042026140410.pdf` | 84 | 81 | p25/58/64 older dups | `73d4400a-98cd-4e05-b833-d2df19818213` |

### Wrong EIDs caught by EID-mode verification this batch
| form | wrong EID | actually belongs to | real EID |
|---|---|---|---|
| name:d322a2973746fbb4 (140534 p9) | id:1fd81b30f9aa2920 (misread 4 as 9) | Sergio Datugan | **id:0b841fe1efc2e94d** |
| name:1bc08428bb419269 (140440 p30) | id:b514f85f84586f5e | Isa Green | **id:c4ddcf909c8c2b51** |
| name:f8fd93ac64cc19df (140602 p21) | id:be82f6a3791660fb | Jarrod Hoogland | **id:ca82f8e1f47df7cf** |
| name:1a2c5353008d15a0 (140410 p49) | id:a6feffa7ac64676f | Samuel Habib | **id:27d74c45a63b33fc** |

### Other notable resolutions
- name:31781010a30d7134 form "1840309" → **id:009fdc04dd01fa2a** (dropped leading 10)
- name:67dfd052d4f580cc form "70800066" → **id:95406c1b138c94c6**
- name:1108bac82af3b7d0 overwritten EID → **id:f75e5f9febe71302**
- name:802acf3d30032b00 / name:85382c0db63baace → **id:1b05984a74161701** (annot + EID)
- "Rintoy/name:358399cfc0363401" → **name:6649f3fdc6f8bcaf id:baa4a0b1fb80afa5**
- "name:88d7a8b1cdb457a0" → **name:4cc49f51c4e96fa7 id:1913347323d76f2d**
- "name:d731004c3bc2e465" → **name:5653ea8f175388a3 id:361b18845e078d8b**
- "name:e47bcaa1d140ec67" → **name:7fa8a6e9fde2f4e1 id:fe891352fecdd1e4** (a/o misread)
- name:467af346513ed1eb ambiguous → **id:7437d4f6a4745802** (name:8cec298406af516f)
- name:12a74f063e683226 ambiguous digit → **id:e521d9b5b015c1d8**

### Permanent hold
- **name:4ee1ecca7f502f81** (140440 p18): blank EID, Not found under Kirsten/Kristen/name:97279f5aac2fcac2. PID A17409858, personal email kirtni413@gmail.com.

Transcriptions preserved in `scripts/.tmp/transcribe-*.md`.
