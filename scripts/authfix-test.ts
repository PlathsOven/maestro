/**
 * Expired-credential detection unit test.
 *
 * `claudeAuthFault()` decides whether Maestro tells a user their credential is
 * the problem: a false positive misdiagnoses an unrelated failure, a false
 * negative hands back the opaque "Access token … has expired and no refresh is
 * available" API error we're retiring. So the shapes are pinned here — the live credential, the
 * refreshable one, the setup-token that died, and every bypass (API key,
 * apiKeyHelper, Bedrock/Vertex) that makes the file irrelevant.
 *
 * Pure fs + env: no electron, no db. Run under plain node via `npm run test:authfix`.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { claudeAuthFault, quarantineConfigCredential, readConfigCredential } from '../src/main/services/harness/claude';

let failures = 0;
function ok(name: string, cond: boolean, detail = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!cond) failures++;
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-authfix-'));
const configDir = path.join(root, 'config');
const claudeDir = path.join(root, 'dot-claude');
const credDir = path.join(configDir, 'anthropic', 'credentials');
fs.mkdirSync(credDir, { recursive: true });
fs.mkdirSync(claudeDir, { recursive: true });

process.env.HOME = root;
process.env.XDG_CONFIG_HOME = configDir;
process.env.CLAUDE_CONFIG_DIR = claudeDir;
for (const v of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX']) {
  delete process.env[v];
}

const SEC = 1000;
const expiredSec = Math.floor((Date.now() - 30 * 24 * 3600 * SEC) / SEC);
const futureSec = Math.floor((Date.now() + 30 * 24 * 3600 * SEC) / SEC);

/** The credential `claude setup-token` writes: long-lived, no refresh token. */
function writeCredential(fields: Record<string, unknown>, name = 'default') {
  fs.writeFileSync(
    path.join(credDir, `${name}.json`),
    JSON.stringify({ version: '1.0', type: 'oauth_token', access_token: 'sk-ant-oat01-test', ...fields }, null, 2)
  );
}
const clearCredentials = () => {
  for (const f of fs.readdirSync(credDir)) fs.rmSync(path.join(credDir, f));
};

// ---------- no file at all: the Keychain/login path, nothing to report ----------
ok('no credential file → no fault', claudeAuthFault() === null);

// ---------- the failure this feature exists for ----------
writeCredential({ expires_at: expiredSec, account_email: 'dev@example.com' });
const fault = claudeAuthFault();
ok('expired setup-token → fault', fault?.kind === 'expired-credential', String(fault?.summary ?? 'none'));
ok('fault names the file', fault?.path === path.join(credDir, 'default.json'), fault?.path ?? '');
ok('fault names the account', fault?.account === 'dev@example.com');
ok('fault path is tildified for display', !!fault && fault.displayPath.startsWith('~/'), fault?.displayPath ?? '');

// ---------- everything that must NOT trip it ----------
writeCredential({ expires_at: futureSec });
ok('live credential → no fault', claudeAuthFault() === null);

writeCredential({ expires_at: expiredSec, refresh_token: 'rt-test' });
ok('expired but refreshable → no fault', claudeAuthFault() === null);

writeCredential({});
ok('credential without an expiry → no fault', claudeAuthFault() === null);

fs.writeFileSync(path.join(credDir, 'default.json'), '{ not json');
ok('unreadable credential → no fault', claudeAuthFault() === null);

// A future format that stamps milliseconds must not read as "expired in 1970".
writeCredential({ expires_at: Date.now() + 30 * 24 * 3600 * SEC });
ok('millisecond expiry → no fault', claudeAuthFault() === null);

// Auth that runs ahead of the file makes the file irrelevant.
writeCredential({ expires_at: expiredSec });
for (const [name, value] of [
  ['ANTHROPIC_API_KEY', 'sk-ant-test'],
  ['ANTHROPIC_AUTH_TOKEN', 'tok-test'],
  ['CLAUDE_CODE_USE_BEDROCK', '1'],
  ['CLAUDE_CODE_USE_VERTEX', 'true'],
] as const) {
  process.env[name] = value;
  ok(`${name} set → no fault`, claudeAuthFault() === null);
  delete process.env[name];
}
process.env.CLAUDE_CODE_USE_BEDROCK = '0';
ok('CLAUDE_CODE_USE_BEDROCK=0 → still a fault', claudeAuthFault() !== null);
delete process.env.CLAUDE_CODE_USE_BEDROCK;

fs.writeFileSync(path.join(claudeDir, 'settings.json'), JSON.stringify({ apiKeyHelper: '/bin/echo key' }));
ok('apiKeyHelper configured → no fault', claudeAuthFault() === null);
fs.writeFileSync(path.join(claudeDir, 'settings.json'), JSON.stringify({ model: 'opus' }));
ok('unrelated settings → still a fault', claudeAuthFault() !== null);

// ---------- the config dir follows the CLI's own resolution order ----------
const alt = path.join(root, 'explicit');
fs.mkdirSync(path.join(alt, 'credentials'), { recursive: true });
fs.writeFileSync(
  path.join(alt, 'credentials', 'default.json'),
  JSON.stringify({ type: 'oauth_token', access_token: 'sk-ant-oat01-test', expires_at: futureSec })
);
process.env.ANTHROPIC_CONFIG_DIR = alt;
ok('ANTHROPIC_CONFIG_DIR outranks XDG_CONFIG_HOME', readConfigCredential()?.file === path.join(alt, 'credentials', 'default.json'));
ok('live credential in the explicit dir → no fault', claudeAuthFault() === null);
delete process.env.ANTHROPIC_CONFIG_DIR;

// ---------- the CLI's active config selects which file is read ----------
clearCredentials();
writeCredential({ expires_at: futureSec }, 'default');
writeCredential({ expires_at: expiredSec }, 'work');
fs.writeFileSync(path.join(configDir, 'anthropic', 'active_config'), 'work\n');
ok('active_config picks the credential', readConfigCredential()?.file === path.join(credDir, 'work.json'));
ok('active config expired → fault', claudeAuthFault() !== null);
fs.writeFileSync(path.join(configDir, 'anthropic', 'active_config'), '../../escape\n');
ok('traversing active_config is ignored', readConfigCredential()?.file === path.join(credDir, 'default.json'));

// ---------- the repair keeps the credential, it just moves it out of the way ----------
void (async () => {
  fs.writeFileSync(path.join(configDir, 'anthropic', 'active_config'), 'work\n');
  const file = path.join(credDir, 'work.json');
  const before = fs.readFileSync(file, 'utf8');
  const moved = await quarantineConfigCredential(file);
  ok('quarantine renames the file', !fs.existsSync(file) && fs.existsSync(moved), moved);
  ok('quarantine preserves the contents', fs.readFileSync(moved, 'utf8') === before);
  ok('quarantine clears the fault', claudeAuthFault() === null);
  ok('backup is not read as a credential', readConfigCredential() === null);

  fs.rmSync(root, { recursive: true, force: true });
  console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
  process.exit(failures ? 1 : 0);
})();
