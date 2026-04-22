# sharepoint — Selector Lessons

Append-only record of selector mistakes and their fixes. Future Claude sessions should read this BEFORE re-mapping a selector. New entries go at the bottom.

Each entry has the same shape so `npm run selector:search` can index it. Required fields: **Tried**, **Failed because**, **Fix**, **Tags**. Optional: **Selector** (if there's a registry entry), **References**.

---

## 2026-04-22 — SharePoint federates through ADFS, not Shibboleth

**Tried:** Reusing the Shibboleth SSO detection + `fillSsoCredentials` helper for SharePoint login (the same helper that works for UCPath / CRM / Kuali / Kronos). The login function checked for `page.url().includes("a5.ucsd.edu")` or `input[name="j_username"]` and, when neither matched, assumed the session was already authed via cached cookies.
**Failed because:** UCSD federates Microsoft AAD through a DIFFERENT SSO front-end for SharePoint / OneDrive — `ad-wfs-aws.ucsd.edu/adfs/ls/` (ADFS), not `a5.ucsd.edu` (Shibboleth). The ADFS form has entirely different field names (`UserName` / `Password` / `#submitButton`) so Shibboleth-scoped selectors silently miss. Result: the code logged "No SSO redirect — possibly already authenticated via cached cookies", advanced without filling credentials, and then failed the post-auth URL check with `Expected SharePoint/Office URL after login, got: https://ad-wfs-aws.ucsd.edu/adfs/ls/`.
**Fix:** Added an ADFS branch alongside the Shibboleth branch in `loginToSharePoint`. Detection is `url.includes("ad-wfs-aws.ucsd.edu") || url.includes("/adfs/ls") || input[name="UserName"] exists`. New selectors live under `adfs.*` in `src/systems/sharepoint/selectors.ts` (primary `input[name="UserName"]` / `input[name="Password"]` / `#submitButton`, with accessible-name fallbacks). Microsoft pre-populates the username field via the `?username=` URL parameter on the redirect, so we only refill it if empty. Password comes from the same `UCPATH_PASSWORD` env var — it's the same UCSD credential.
**Selector:** `adfs.usernameInput`, `adfs.passwordInput`, `adfs.submitButton` in `selectors.ts`
**Tags:** sharepoint, adfs, ucsd, sso, federation, login, password, duo, microsoft, onedrive
**References:** `src/workflows/sharepoint-download/download.ts` (handleAdfsLogin)
