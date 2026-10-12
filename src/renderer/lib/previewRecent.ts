// Recently previewed URLs per project, for the Preview empty state. Loopback
// spellings fold to `localhost` and credentials are stripped before storing.

const KEY = 'maestro.previewRecent';
const MAX = 8;

function normalize(raw: string): string | null {
  try {
    const u = new URL(raw);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    if (['127.0.0.1', '0.0.0.0', '[::1]', '[::]'].includes(u.hostname)) u.hostname = 'localhost';
    u.username = u.password = u.hash = '';
    return u.toString();
  } catch {
    return null;
  }
}

function load(): Record<string, string[]> {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '{}') ?? {};
  } catch {
    return {};
  }
}

export function recentPreviewUrls(projectId: string): string[] {
  return load()[projectId] ?? [];
}

export function rememberPreviewUrl(projectId: string, raw: string): void {
  const url = normalize(raw);
  const all = load();
  const list = all[projectId] ?? [];
  if (!url || list[0] === url) return;
  all[projectId] = [url, ...list.filter((u) => u !== url)].slice(0, MAX);
  try {
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    /* storage unavailable — no history */
  }
}
