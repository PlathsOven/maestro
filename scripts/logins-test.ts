/**
 * Multi-login rotation unit test (spec multi-login-rotation.md, Acceptance).
 *
 * Pins the pure pieces the rest of the feature is assembled from:
 *   - secureStorageService(): the macOS-Keychain service name per login dir —
 *     unset, a plain dir, and an NFD-decomposed accent that must hash the same
 *     as its NFC form (the CLI normalizes before hashing, fact 2).
 *   - parseClaudeLine() on `rate_limit_event`: a `rejected` line becomes one
 *     `limit` event with ms `resetsAt` (seconds are scaled, ms pass through);
 *     `allowed_warning` produces nothing.
 *   - looksLikeLimitError(): the five limit texts (fact 6) read as limits; an
 *     auth 401 and an ordinary tool error do not.
 *   - nextLogin(): prefers an unlimited active that isn't the failed one, wraps
 *     after the last, returns null when every other login is limited, and never
 *     returns the failed id.
 *
 * Pure: no electron, no db. Run under plain node via `npm run test:logins`.
 */
import { secureStorageService } from '../src/main/services/harness/claude';
import { parseClaudeLine } from '../src/shared/harness/parse';
import { looksLikeAuthError, looksLikeLimitError, nextLogin } from '../src/shared/harness/limits';
import type { AgentEvent } from '../src/shared/types';

let failures = 0;
function ok(name: string, cond: boolean, detail = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!cond) failures++;
}

// ---------- secureStorageService ----------
ok('unset dir -> plain service name', secureStorageService() === 'Claude Code-credentials');
ok('unset === explicit undefined', secureStorageService(undefined) === secureStorageService());

const plain = secureStorageService('/tmp/logins/claude-code/abc');
ok('a dir -> suffixed service name', /^Claude Code-credentials-[0-9a-f]{8}$/.test(plain), plain);
ok('same dir -> stable hash', plain === secureStorageService('/tmp/logins/claude-code/abc'));
ok('different dir -> different hash', plain !== secureStorageService('/tmp/logins/claude-code/xyz'));

// "café" decomposed (e + combining acute U+0301, NFD) vs composed
// ("café", NFC): different bytes, but the CLI normalizes to NFC before
// hashing, so both must map to the same service name (fact 2).
const DECOMPOSED = '/tmp/logins/café';
const NFD = DECOMPOSED.normalize('NFD');
const NFC = DECOMPOSED.normalize('NFC');
ok('the two accent forms are genuinely different bytes', NFD !== NFC);
ok('NFD accent hashes as its NFC form', secureStorageService(NFD) === secureStorageService(NFC));

// ---------- parseClaudeLine on rate_limit_event ----------
const limitEvents = (line: string) =>
  parseClaudeLine(line).filter((e): e is Extract<AgentEvent, { kind: 'limit' }> => e.kind === 'limit');

const rejectedSeconds = JSON.stringify({
  type: 'rate_limit_event',
  rate_limit_info: { status: 'rejected', resetsAt: 1757278800, rateLimitType: 'five_hour', utilization: 1 },
});
const secEvts = limitEvents(rejectedSeconds);
ok('rejected (seconds) -> one limit event', secEvts.length === 1);
ok('resetsAt scaled to ms', secEvts[0]?.resetsAt === 1757278800 * 1000, String(secEvts[0]?.resetsAt));
ok('window carried through', secEvts[0]?.window === 'five_hour');

const rejectedMs = JSON.stringify({
  type: 'rate_limit_event',
  rate_limit_info: { status: 'rejected', resetsAt: 1757278800000, rateLimitType: 'seven_day' },
});
const msEvts = limitEvents(rejectedMs);
ok('rejected (ms) -> resetsAt unchanged', msEvts[0]?.resetsAt === 1757278800000, String(msEvts[0]?.resetsAt));

const warning = JSON.stringify({
  type: 'rate_limit_event',
  rate_limit_info: { status: 'allowed_warning', utilization: 0.9 },
});
ok('allowed_warning -> no limit event', limitEvents(warning).length === 0);

const allowed = JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed' } });
ok('allowed -> no limit event', limitEvents(allowed).length === 0);

// ---------- looksLikeLimitError ----------
for (const t of [
  "You've hit your limit",
  "You've hit your monthly spend limit",
  "You've reached your Claude usage limit",
  'Usage limit reached',
  "You're out of usage credits",
]) {
  ok(`limit text -> true: "${t.slice(0, 32)}"`, looksLikeLimitError(t));
}
ok('401 Unauthorized -> false', !looksLikeLimitError('API Error: 401 Unauthorized'));
ok('ordinary tool error -> false', !looksLikeLimitError('Error: file not found: /tmp/x'));

// ---------- looksLikeAuthError (the sibling matcher that offers the sign-in fix) ----------
for (const t of [
  'Failed to authenticate: OAuth session expired and could not be refreshed',
  'API Error: 401 Unauthorized',
  'Access token at ~/x has expired and no refresh is available (client_id set, refresh_token empty)',
  'Please run /login',
  'You are not signed in',
  'unable to refresh token',
]) {
  ok(`auth text -> true: "${t.slice(0, 40)}"`, looksLikeAuthError(t));
}
// Must not fire on limits (they rotate/notify instead) or ordinary errors.
ok('usage limit -> not auth', !looksLikeAuthError("You've reached your Claude usage limit"));
ok('file error -> not auth', !looksLikeAuthError('Error: file not found: /tmp/x'));
ok('diff mentioning refresh -> not auth', !looksLikeAuthError('diff --git a/x b/x refreshed the view'));

// ---------- nextLogin ----------
const L = (ids: string[]) => ids.map((id) => ({ id }));
const none = () => false;
const limitedSet =
  (...ids: string[]) =>
  (id: string) =>
    ids.includes(id);

// The user already moved active off the failed one -> use the active login.
ok('prefers an unlimited active that is not the failed one', nextLogin(L(['a', 'b', 'c']), 'a', 'c', none)?.id === 'c');
// Active === failed -> walk forward from the failed login.
ok('walks forward when active is the failed login', nextLogin(L(['a', 'b', 'c']), 'a', 'a', none)?.id === 'b');
// Wraps past the end of the list.
ok('wraps after the last login', nextLogin(L(['a', 'b', 'c']), 'c', 'c', none)?.id === 'a');
// Every other login limited -> null.
ok('null when all others are limited', nextLogin(L(['a', 'b', 'c']), 'a', 'a', limitedSet('b', 'c')) === null);
// Never returns the failed id, even when it's the only unlimited one.
ok('never returns the failed id', nextLogin(L(['a', 'b']), 'a', 'a', limitedSet('b')) === null);
// Skips a limited candidate to reach an unlimited later one.
ok('skips a limited candidate', nextLogin(L(['a', 'b', 'c']), 'a', 'a', limitedSet('b'))?.id === 'c');

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
