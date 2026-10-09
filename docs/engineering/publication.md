# Local data and publication

## Keep operational data local

Git tracks code, synthetic fixtures, and maintained documentation. Operator data belongs in ignored paths: `.env`, `.auth/`, `.tracker/`, `.screenshots/`, `.private/`, `data/`, `generated/` run directories, and `config/settings.json`. The roster generator and empty directory markers remain tracked. Do not store real employee records in test fixtures or tracked workflow-design snapshots.

The private Duo Autopilot checkout and machine agent configuration are excluded from the public tree. Keep existing local copies when applying this branch. Ordinary dashboard runs and system drivers retain their existing behavior. The Kronos debug and verification utilities require explicit EIDs instead of selecting employees by default. SharePoint authentication still uses the configured operator and the UCSD tenant domain.

Synthetic fixtures preserve identity relationships, malformed-input cases, and field formats. `900000xx` identifies mock dashboard records. Fixtures requiring the production EID validator use manufactured `1000xxxx` or `1009xxxx` values. Contact mail uses example domains. Employee and transaction identifiers in historical examples are fictional; verification dates describe the engineering fix. SSN boundary values are limited to tests of masking, formatting, and the UCPath rejection range. Engineering dates and annual configuration are technical context, not employee birth dates.

## Publication gates

1. Obtain written approval from the operator's UCSD supervisor to publish the code and its system integration details. This is an operator-owned gate. No upload or visibility change precedes it. This document records a release condition, not a determination of UC ownership.
2. Inventory every tracked file and fixture name column. Scan emails, eight-digit IDs, phones, SSNs, birth-date fields, local paths, and structured fixture identity fields. Keep reports containing original values outside the repository. Review images, PDFs, spreadsheets, and CSVs individually. Regenerate screenshots from the mock preview.
3. Replace actual people and identifiers with deterministic synthetic fixtures. Keep original local data and replacement mappings private. Preserve validation, identity checks, assertions, and negative test cases.
4. Run Gitleaks on the exact candidate export. Explain detector hits individually. Verify that credential files, tokens, enrolled authenticator keys, local settings, and private tool checkouts are absent.
5. Review drivers, selectors, URLs, workflow descriptions, and organizational rules separately. These expose system structure and business procedures even after personal data is removed. Retaining them preserves local functionality; publication still requires explicit institutional approval. A public login URL does not establish permission to disclose authenticated page details.
6. Run backend and dashboard type checks, lint, the unit and serial integration lanes, architecture checks, dashboard build, mock visual checks, and actual coverage. Record inherited failures and unavailable gates. A no-op rebuild coverage command is not production coverage evidence.
7. Re-scan the exact candidate tree after all changes. Every detector hit needs a recorded disposition. Review the tree and screenshots before approving publication.

## Replace the existing repository's history

Making the existing repository public exposes its reachable history as well as its current files. A sanitation commit on top of the old history is insufficient.

Prepare a separate local repository containing only the approved tree and one fresh root commit. Preserve the original private repository, branches, and local files as a private backup. The frozen architecture manifests reference the `public-baseline` tag on the fresh root commit. Publish that tag with the approved root. Exact file inventories, content hashes, lint fingerprints, and future change accounting remain enforced without the old private Git objects.

Before replacing private GitHub refs, inventory branches, tags, pull-request refs, releases and assets, Git LFS objects, Actions logs, artifacts and caches, and other uploaded attachments. Resolve sensitive retained surfaces while the repository is private. The read-only inventory on 2026-10-09 found `master` and five closed PR head refs (`1` through `5`), with no releases, Actions runs, artifacts, or caches. Recheck these surfaces immediately before release. [GitHub documents](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/removing-sensitive-data-from-a-repository) that old commits can remain reachable through PR references and cached views after a force-push; sensitive-data removal may require GitHub Support. Keep the sanitized repository private for the operator's final review, then let the operator change visibility. Local preparation does not authorize pushing, deleting remote history, or changing visibility.

No release approval is recorded here. Local preparation can continue while the operator obtains written approval.

## Adopt the prepared code locally

The production checkout may contain newer uncommitted work. Review and integrate that work before adopting the sanitized branch; never reset or clean it to match the public snapshot. Keep the private history as a local backup, and preserve `.agents/`, `.codex/`, `.claude/`, and the separate `duo-autopilot/` checkout before switching away from a branch that tracked them. Restore those local copies as ignored files if Git removes previously tracked files during the switch. Keep the existing `.env`, `.auth/`, tracker, settings, rosters, and output directories at their current paths. The public candidate contains none of that operational state.
