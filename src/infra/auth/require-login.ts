import type { Page } from "playwright";
import type { SystemConfig } from "../../core/kernel/types.js";

/**
 * Wraps a boolean-returning login function into the `SystemConfig.login`
 * shape, throwing `failureMessage` when the login returns falsy.
 *
 * Before this helper, every workflow contained the same three-line closure:
 *   login: async (page, instance, context) => {
 *     const ok = await loginToXxx(page, instance, context?.abortSignal);
 *     if (!ok) throw new Error("Xxx authentication failed");
 *   }
 * `requireLogin` eliminates that boilerplate so the failure message is the
 * only decision left to each call site.
 *
 * The wrapped function may return `boolean` or `"already_logged_in"` (a
 * truthy string treated as success, matching the UKG login contract).
 */
export function requireLogin(
  loginFn: (
    page: Page,
    instance?: string,
    abortSignal?: AbortSignal,
  ) => Promise<boolean | string>,
  failureMessage: string,
): SystemConfig["login"] {
  return async (page, instance, context) => {
    const ok = await loginFn(page, instance, context?.abortSignal);
    if (!ok) throw new Error(failureMessage);
  };
}

/**
 * Wraps a boolean-returning `prepareLogin` function into the
 * `SystemConfig.prepareLogin` shape, throwing `failureMessage` when the
 * function returns `false`.
 *
 * `"already_logged_in"` and `true` are both treated as success (truthy), so
 * callers that return the full `SsoPrepareResult` union are handled correctly.
 *
 * Note the string is DISCARDED here by design — `SystemConfig.prepareLogin`
 * returns `Promise<void>`, so the kernel cannot skip the subsequent `login`
 * phase based on it. The warm-page short-circuit therefore lives in the paired
 * submit helper (`ucpathSubmitAndWaitForDuo` / `kualiSubmitAndWaitForDuo` /
 * `newKronosSubmitAndWaitForDuo`), each of which returns `true` without
 * clicking submit when its stale-form re-prepare reports `"already_logged_in"`.
 */
export function requirePrepareLogin(
  prepareFn: (page: Page) => Promise<boolean | string>,
  failureMessage: string,
): NonNullable<SystemConfig["prepareLogin"]> {
  return async (page) => {
    const prep = await prepareFn(page);
    if (prep === false) throw new Error(failureMessage);
  };
}
