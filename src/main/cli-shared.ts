/**
 * Shared plumbing for the three agent-facing CLIs (maestro-ask / maestro-role /
 * maestro-preview). Each is its own esbuild --bundle entry, so this module inlines
 * into all three — no separate artifact ships. Plain Node builtins only.
 */
import http from 'http';

/** Build a `fail(msg)` that prints under the CLI's name and exits non-zero. */
export function makeFail(prefix: string): (msg: string) => never {
  return (msg) => {
    process.stderr.write(`${prefix}: ${msg}\n`);
    process.exit(1);
  };
}

/** Read all of stdin (empty when attached to a TTY or on error). */
export function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve('');
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (data += c));
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(data));
  });
}

/** POST a JSON body to a Maestro loopback route with the bearer token; the reply
 *  is handed to `onResponse(statusCode, out)` and connection errors to `fail`. */
export function postJson(
  url: string,
  token: string,
  path: string,
  body: string,
  fail: (msg: string) => never,
  onResponse: (statusCode: number | undefined, out: string) => void
): void {
  const req = http.request(
    new URL(path, url),
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
        authorization: `Bearer ${token}`,
      },
    },
    (res) => {
      let out = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (out += c));
      res.on('end', () => onResponse(res.statusCode, out));
    }
  );
  req.on('error', (e) => fail(`could not reach Maestro: ${e.message}`));
  req.write(body);
  req.end();
}
