# Logging Vocabulary

The names for everything the app **records while it works**, and what the code
calls each one today. Use the **keeper name** when talking or writing new code;
the right-hand column is only there so you can find it in the files.

Like `workflow-vocabulary.md`, this doc is the spec. Where a code name disagrees
with a keeper here, the code name is the one we retire.

---

## How the names are chosen (the rules)

So you can predict and check a name, not just memorize it:

1. **One thing, one name.** Two words for the same thing → keep one, retire the other.
2. **Name it after what it does, in plain words.** No metaphors, no jargon.
3. **Same pattern for the same kind of thing.** All logs are named `<scope> log`
   (`run log`, `session log`) so related things read alike.
4. **Specific beats short.** `daemon log line` over `entry`.
5. **Matching pairs.** A person's task and the background version use the same
   shape (`run log context` ↔ `daemon log context`).

---

## The two logs

A **log** is a stream of time-stamped lines written as the app works. There are
exactly two, split by *what they describe*:

| Keeper name | What it records | In the code today |
|---|---|---|
| **run log** | The steps of **one run** — what the automation did for one subject, line by line. | `logs`, `LogEntry`, `.tracker/logs/{workflow}-{date}.jsonl`, `logs` table |
| **session log** | The **machinery** — browser open/close, login, screenshots, the daemon starting and stopping. Not tied to one subject. | `session events`, `SessionEvent`, `.tracker/sessions/{date}.jsonl`, `session_events` table |

Both are written the same way and stored the same way (below). They differ only
in scope: **run log = one run**, **session log = the machine**.

---

## Where logs are stored

Every line is written **twice**, on purpose:

| Keeper name | What it is | In the code today |
|---|---|---|
| **log file** | The line on disk, as plain text, one line per row. Written first. The source of truth. | `.jsonl` files |
| **database** | A copy of every line in a real database, so the dashboard can look things up fast. Rebuilt from the log files if it's ever lost. | SQLite, `state.db`, "the projection" |

Rule: the **log file** is the truth; the **database** is a fast copy of it.

---

## Units of work (the look-alike words)

These sound similar but mean different things. This is the table to come back to.

| Keeper name | What it is | In the code today |
|---|---|---|
| **workflow** | A *kind* of job: onboarding, separation, EID lookup. | `workflow` |
| **subject** | The person or file a job is *about*. | `itemId`, `item` |
| **run** | *One go* at one subject. Each retry is a new run. | `runId`, `run` |
| **task** | The queued **to-do** the daemon picks up and works. | `tasks` table |
| **attempt** | One *try* of a task. A retry makes a new attempt. | `task_attempts` table |
| **daemon** | The **background helper** that runs the queue and stays alive between runs. | `daemon` |

(The dashboard cards that show each run's status are **rows** — defined in
`workflow-vocabulary.md`, not here. A row is built *from* the logs; it is not a
log itself.)

---

## Log context (what today's fix is about)

Every log line must be stamped with **which run or daemon it belongs to**, or it
gets thrown away before it's saved.

| Keeper name | What it is | In the code today |
|---|---|---|
| **log context** | The stamp on a log line saying who it belongs to. No stamp → the line is dropped, never saved. | `LogContext`, `ctx` |
| **run log context** | A log context for one **run**. Stamps run log lines. Already exists. | `withLogContext` |
| **daemon log context** | A log context for the **daemon**. Stamps daemon log lines. *Does not exist yet — this is the fix.* | `withDaemonLogContext` *(to add)* |
| **daemon log line** | A line the daemon writes about itself. Stored in the **session log**. | `daemon_log` event *(to add)* |

Today the daemon has **no log context**, so every line it writes is dropped. The
fix adds a **daemon log context** and stores its lines in the **session log** —
the same shape the **run log context** already uses for runs.

---

## Names to retire

When you see the left side in code, it means the keeper on the right. Don't add
new uses of the left; rename toward the keeper over time.

| Seen in code | Keeper |
|---|---|
| `entry`, `row` (for a log line) | **log line** |
| `session events` | **session log** |
| `the projection` | **database** |
| `item` (for a person) | **subject** |
