# Phase 1: Authentication and Project Foundation - Context

**Gathered:** 2026-03-13
**Status:** Ready for planning

<domain>
## Phase Boundary

Establish authenticated browser sessions to both UCPath (ucpath.ucsd.edu) and ACT CRM onboarding portal (act-crm.my.site.com) through UCSD SSO with Duo MFA pause. Includes project scaffolding, credential security (.env), PII-safe logging, and a `test-login` CLI command to verify authentication. Session persistence between runs. No data extraction or form entry -- those are later phases.

</domain>

<decisions>
## Implementation Decisions

### MFA Pause Behavior
- Console message notification only ("Waiting for Duo approval...") -- no OS notifications or browser focus tricks
- 15-second timeout for Duo approval
- On timeout: retry once (another 15s window), then exit with clear error
- ACT CRM separate login (if needed) handled silently -- auto-detect login page, select "Active Directory", enter same credentials, wait for Duo if required

### Session Persistence
- Save browser state (cookies/storage) to `.auth/` directory in project root
- `.auth/` added to `.gitignore` -- never committed
- On stale/expired session: silently clear and fall back to full login flow (no user prompt)
- `--fresh` CLI flag to force fresh login (ignores saved session)

### CLI Output Style
- Step-by-step status messages at key milestones: "Navigating to UCPath...", "Login page loaded", "Waiting for Duo...", "Authenticated"
- Brief summary at end: show auth status for both systems and session save confirmation
- Colors + symbols throughout: green checkmark for success, yellow hourglass for waiting, red X for errors
- Never show PII in terminal output -- no username, email, or credentials displayed. Just "Entering credentials..."

### Auth Failure Recovery
- Wrong password / SSO error: exit immediately with specific error message (e.g., "SSO login failed: invalid credentials")
- Browser crash / page load failure: retry once (close and relaunch browser), then exit with error
- Validate `.env` has all required fields (USERNAME, PASSWORD) at startup before launching browser -- fail early with message listing what's missing
- Close browser after successful test-login (session is saved to `.auth/`)

### Claude's Discretion
- Project scaffolding structure (TypeScript config, folder layout, package manager)
- Playwright browser choice and configuration
- Exact selector strategies for PeopleSoft/SSO pages
- Session detection mechanism (how to determine if already logged in)
- Internal error handling and logging implementation

</decisions>

<specifics>
## Specific Ideas

No specific requirements -- open to standard approaches for project setup and browser automation.

</specifics>

<code_context>
## Existing Code Insights

### Reusable Assets
- None -- greenfield project with no existing source code

### Established Patterns
- None yet -- this phase establishes the foundational patterns

### Integration Points
- `.env` file already exists in project root (credentials storage)
- `.gitignore` already exists (needs `.auth/` added)

</code_context>

<deferred>
## Deferred Ideas

None -- discussion stayed within phase scope

</deferred>

---

*Phase: 01-authentication-and-project-foundation*
*Context gathered: 2026-03-13*
