import { app } from 'electron';
import os from 'os';
import { Hosts, Settings } from '../db';
import { captureNow } from './analytics';
import type { ErrorRef } from '../../shared/types';

// User feedback + one-click error reports (§10). Both are PostHog events on the
// same anonymous per-install id analytics already uses — no new infrastructure,
// and a report lands where the developer already looks, tied to that install's
// app_opened context. The ONLY content ever sent is what the user typed and, for
// an error report, that error's message; diagnostics are the same non-identifying
// fields app_opened sends. No paths, prompts, repo names, or logs.

export async function sendFeedback(req: {
  text: string;
  includeDiagnostics: boolean;
  error?: ErrorRef;
}): Promise<{ ok: boolean; error?: string }> {
  const text = req.text.trim();
  if (!text && !req.error) return { ok: false, error: 'Nothing to send' };
  const props: Record<string, unknown> = { text: text.slice(0, 4000) };
  if (req.error) props.error = { message: req.error.message.slice(0, 2000), source: req.error.source, at: req.error.at };
  if (req.includeDiagnostics) {
    Object.assign(props, {
      version: app.getVersion(),
      os: process.platform,
      arch: process.arch,
      os_version: os.release(),
      default_harness: Settings.global().defaultHarness,
      remote_hosts: Hosts.list().length,
    });
  }
  // A one-click error report (no typed text) is an `error_report`; anything the
  // user actually wrote is `feedback`.
  const sent = await captureNow(req.error && !text ? 'error_report' : 'feedback', props);
  return sent ? { ok: true } : { ok: false, error: 'Feedback is off in dev builds (set MAESTRO_ANALYTICS_DEV=1)' };
}
