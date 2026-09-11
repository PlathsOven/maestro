import { app } from 'electron';
import os from 'os';
import { PostHog } from 'posthog-node';
import { Settings, uid } from '../db';

// Anonymous usage analytics — powers "how many people run Maestro" (DAU/WAU/MAU,
// retention, version adoption). The only identifier ever sent is a random
// per-install id; no account, no repo names, no prompts, no PII — and, only when
// the user presses Send in the feedback box or Report on an error, the text they
// typed plus that error's message (§10).
//
// The PostHog *project* API key is a publishable client key: it is designed to
// ship inside distributed client apps (it is exactly what posthog-js embeds in
// every website's HTML), so committing it is fine. Override it at build time
// with MAESTRO_POSTHOG_KEY (e.g. in release CI) if you ever rotate it. Point at
// the EU cloud by setting MAESTRO_POSTHOG_HOST=https://eu.i.posthog.com.
const POSTHOG_KEY = process.env.MAESTRO_POSTHOG_KEY || 'phc_REPLACE_WITH_YOUR_POSTHOG_PROJECT_KEY';
const POSTHOG_HOST = process.env.MAESTRO_POSTHOG_HOST || 'https://us.i.posthog.com';

// A real key is a `phc_…` token. The committed placeholder leaves analytics off,
// so forks that never set a key — and this repo until the key is filled in —
// emit nothing.
const keyConfigured = /^phc_/.test(POSTHOG_KEY) && !POSTHOG_KEY.includes('REPLACE');

let client: PostHog | null = null;

/**
 * The anonymous, per-install id — the only thing that identifies an event.
 * Minted once and persisted in the settings table alongside everything else in
 * maestro.db; wiping app data mints a fresh one, which simply reads as a new
 * install. Kept private on purpose: nothing outside this module needs it.
 */
function installId(): string {
  let id = Settings.raw('installId');
  if (!id) {
    id = uid();
    Settings.setRaw('installId', id);
  }
  return id;
}

/**
 * Start anonymous analytics and record the launch. Mirrors the updater's dev
 * posture: a no-op in dev/smoke runs (unpackaged) unless MAESTRO_ANALYTICS_DEV=1
 * is set for testing, and a no-op until a real project key is configured. Must
 * run after initDb() — it reads/writes the settings table for the install id.
 */
export function initAnalytics(): void {
  if (!keyConfigured) return;
  if (!app.isPackaged && process.env.MAESTRO_ANALYTICS_DEV !== '1') return;
  try {
    client = new PostHog(POSTHOG_KEY, {
      host: POSTHOG_HOST,
      // A desktop app can be quit seconds after launch, so we can't wait for a
      // batch to fill — send each event on its own.
      flushAt: 1,
    });
    capture('app_opened', {
      version: app.getVersion(),
      os: process.platform,
      arch: process.arch,
      os_version: os.release(),
      locale: app.getLocale(),
      // Mirror the current install onto the person so active users can be
      // segmented by version/OS, not just events.
      $set: { app_version: app.getVersion(), os: process.platform, arch: process.arch },
    });
  } catch (err) {
    // Analytics must never take the app down.
    console.error('[analytics] init failed', err);
    client = null;
  }
}

/**
 * Record an anonymous event (e.g. a feature the team wants a usage signal on).
 * A no-op until initAnalytics() has wired up a client, so callers never need to
 * guard. Keep property values non-identifying — counts and enums, not content.
 */
export function capture(event: string, properties?: Record<string, unknown>): void {
  if (!client) return;
  try {
    client.capture({ distinctId: installId(), event, properties });
  } catch (err) {
    console.error('[analytics] capture failed', err);
  }
}

/**
 * Capture an event and flush it right away. Unlike `capture` (fire-and-forget),
 * this awaits the send so a user pressing "Send" / "Report" gets a truthful
 * result. Returns false when analytics is off (a dev build without
 * MAESTRO_ANALYTICS_DEV=1, or no configured key) — so the UI can say so (§10).
 */
export async function captureNow(event: string, properties: Record<string, unknown>): Promise<boolean> {
  if (!client) return false;
  try {
    client.capture({ distinctId: installId(), event, properties });
    await client.flush();
    return true;
  } catch (err) {
    console.error('[analytics] captureNow failed', err);
    return false;
  }
}

/**
 * Best-effort flush on quit. Non-blocking on purpose: quitting must never hang
 * on the network, and the launch ping already flushed (flushAt: 1) — this only
 * catches anything captured late in the session.
 */
export function shutdownAnalytics(): void {
  if (!client) return;
  try {
    void client.shutdown(2000);
  } catch {
    /* best-effort */
  }
  client = null;
}
