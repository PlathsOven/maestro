/**
 * Pure selection + detection helpers for multi-login usage-limit rotation
 * (spec multi-login-rotation.md). No node builtins, no main-process imports, so
 * the registry (`src/main/services/harness/logins.ts`) and the unit test
 * (`scripts/logins-test.ts`) both run this exact code under plain node.
 */

/**
 * The login a limited turn should re-run under, or null when every option is
 * limited. Prefers the active login when the user already moved off the failed
 * one; otherwise the next unlimited login after `failedId` in list order,
 * wrapping. Never returns `failedId`.
 */
export function nextLogin<T extends { id: string }>(
  logins: T[],
  failedId: string,
  activeId: string,
  isLimited: (id: string) => boolean
): T | null {
  // The user may have already picked a different active login (via the popover)
  // while this turn was in flight; honour that pick when it's usable.
  if (activeId !== failedId) {
    const active = logins.find((l) => l.id === activeId);
    if (active && !isLimited(active.id)) return active;
  }
  const start = logins.findIndex((l) => l.id === failedId);
  // Walk the list once starting after the failed login, wrapping. When the
  // failed id is gone, start from the top (start === -1 → first index is 0).
  for (let i = 1; i <= logins.length; i++) {
    const cand = logins[(start + i) % logins.length];
    if (cand.id !== failedId && !isLimited(cand.id)) return cand;
  }
  return null;
}

/** Does a turn's error text read like a usage limit (not an auth failure)? */
export function looksLikeLimitError(text: string): boolean {
  return /you've (hit|reached) your .{0,40}limit|usage limit reached|out of usage credits|rate_limit_error|\b429\b/i.test(
    text
  );
}

/**
 * Does a turn's error text read like a sign-in failure the user fixes by
 * re-authenticating? Covers the CLIs' own wordings — bare HTTP 401/403, the
 * classic "no refresh is available", and the OAuth-session flavours ("session
 * expired", "could not be refreshed", "failed to authenticate") — while staying
 * off ordinary tool/diff errors that merely mention "refresh". Sibling of
 * `looksLikeLimitError`; a limit is not an auth failure.
 */
export function looksLikeAuthError(text: string): boolean {
  return /\b(401|403)\b|unauthorized|forbidden|unauthenticated|not (logged|signed) in|authentication (failed|error|required)|failed to (authenticate|authorize|log ?in|sign ?in)|invalid (api key|token|credentials)|expired (token|credentials|session)|session .{0,20}expired|token .{0,40}has expired|(could ?not|couldn'?t|unable to|failed to) .{0,20}refresh|no refresh is available|please (run .*login|log ?in|sign ?in)/i.test(
    text
  );
}
