// Ping IndexNow with every URL in landing/sitemap.xml so Bing, Yandex, Seznam
// and Naver recrawl right away instead of on their own schedule. Kagi, a top
// referrer for the public repo, draws on those indexes, so this is how landing
// changes reach Kagi quickly. Run after a landing deploy is live:
//
//   npm run indexnow            # all sitemap URLs
//   npm run indexnow -- /windows /changelog   # just these paths
//
// The key file (landing/<key>.txt) must be served at the site root; that is how
// IndexNow verifies we own the host.
import { readFileSync } from 'node:fs';

const HOST = 'maestro-build.com';
const KEY = '4f3274c550370c3e5af1e787792dcd8a';

const paths = process.argv.slice(2);
const urls = paths.length
  ? paths.map((p) => `https://${HOST}${p.startsWith('/') ? p : '/' + p}`)
  : [...readFileSync(new URL('../landing/sitemap.xml', import.meta.url), 'utf8').matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);

const res = await fetch('https://api.indexnow.org/indexnow', {
  method: 'POST',
  headers: { 'content-type': 'application/json; charset=utf-8' },
  body: JSON.stringify({ host: HOST, key: KEY, keyLocation: `https://${HOST}/${KEY}.txt`, urlList: urls }),
});
console.log(`IndexNow: ${res.status} ${res.statusText} for ${urls.length} URL(s)`);
if (!res.ok && res.status !== 202) {
  console.log(await res.text());
  process.exit(1);
}
