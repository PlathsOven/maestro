import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from 'child_process';
import path from 'path';
import { app } from 'electron';
import { broadcast } from '../bus';
import { childEnv } from '../env';

// On-device dictation, driven by the bundled Swift `maestro-dictation` helper
// (SFSpeechRecognizer + AVAudioEngine). One helper process per session; it
// streams line-delimited JSON on stdout and finalizes on a "stop" line. macOS
// only — everywhere else dictation reports unsupported and the UI hides the
// button. See src/native/dictation/main.swift for the wire protocol.

/** Path to the helper: alongside the packaged app's resources, else the build output. */
function helperPath(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'maestro-dictation')
    : path.join(app.getAppPath(), 'dist', 'native', 'maestro-dictation');
}

type HelperMsg =
  | { type: 'capability'; supported: boolean; available: boolean; onDevice: boolean; authStatus: string }
  | { type: 'ready' }
  | { type: 'partial'; text: string }
  | { type: 'final'; text: string }
  | { type: 'error'; message: string };

/** Split a stdout stream into whole JSON lines; returns parsed messages and the leftover. */
function drainLines(buf: string): { msgs: HelperMsg[]; rest: string } {
  const msgs: HelperMsg[] = [];
  let rest = buf;
  let nl: number;
  while ((nl = rest.indexOf('\n')) >= 0) {
    const line = rest.slice(0, nl).trim();
    rest = rest.slice(nl + 1);
    if (!line) continue;
    try {
      msgs.push(JSON.parse(line) as HelperMsg);
    } catch {
      // ignore non-JSON noise on stdout
    }
  }
  return { msgs, rest };
}

let supportedCache: Promise<{ supported: boolean; onDevice: boolean; reason?: string }> | null = null;

/** Whether on-device dictation can run here. Cached — the recognizer's presence
 *  doesn't change within a session (authorization is handled at start time). */
export function dictationSupported(): Promise<{ supported: boolean; onDevice: boolean; reason?: string }> {
  if (process.platform !== 'darwin') {
    return Promise.resolve({ supported: false, onDevice: false, reason: 'macOS only' });
  }
  if (!supportedCache) supportedCache = probeSupport();
  return supportedCache;
}

function probeSupport(): Promise<{ supported: boolean; onDevice: boolean; reason?: string }> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(helperPath(), ['--check'], { env: childEnv(), stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      resolve({ supported: false, onDevice: false, reason: 'helper missing' });
      return;
    }
    let out = '';
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {}
      resolve({ supported: false, onDevice: false, reason: 'probe timed out' });
    }, 5_000);
    child.stdout?.on('data', (d: Buffer) => (out += d.toString()));
    child.on('error', () => {
      clearTimeout(timer);
      resolve({ supported: false, onDevice: false, reason: 'helper missing' });
    });
    child.on('close', () => {
      clearTimeout(timer);
      const cap = drainLines(out).msgs.find((m) => m.type === 'capability');
      if (cap && cap.type === 'capability' && cap.supported) {
        resolve({ supported: true, onDevice: cap.onDevice });
      } else {
        resolve({ supported: false, onDevice: false, reason: 'unsupported' });
      }
    });
  });
}

interface Session {
  id: string;
  child: ChildProcessWithoutNullStreams;
}
let active: Session | null = null;

/** Hard-stop a session's helper without emitting further events for it. */
function teardown(session: Session) {
  session.child.removeAllListeners();
  session.child.stdout.removeAllListeners();
  session.child.stderr?.removeAllListeners();
  try {
    session.child.kill('SIGKILL');
  } catch {}
  if (active?.id === session.id) active = null;
}

/** Start a dictation session; results stream back via the `dictation:*` events. */
export function startDictation(opts: { sessionId: string; lang?: string }): { ok: boolean; error?: string } {
  if (process.platform !== 'darwin') return { ok: false, error: 'Dictation is only available on macOS.' };
  if (active) {
    // One mic at a time: displace the previous session and reset its composer
    // (an empty final ends its listening state without a toast).
    const prev = active;
    teardown(prev);
    broadcast('dictation:final', { sessionId: prev.id, text: '' });
  }

  const args = ['--lang=' + (opts.lang || 'en-US')];
  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawn(helperPath(), args, { env: childEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
  } catch (e: any) {
    return { ok: false, error: String(e?.message ?? e) };
  }
  const session: Session = { id: opts.sessionId, child };
  active = session;

  let buf = '';
  let ended = false;
  const end = () => {
    if (active?.id === session.id) active = null;
    ended = true;
  };

  child.stdout.on('data', (d: Buffer) => {
    const { msgs, rest } = drainLines(buf + d.toString());
    buf = rest;
    for (const m of msgs) {
      if (m.type === 'partial') broadcast('dictation:partial', { sessionId: session.id, text: m.text });
      else if (m.type === 'final') {
        broadcast('dictation:final', { sessionId: session.id, text: m.text });
        end();
      } else if (m.type === 'error') {
        broadcast('dictation:error', { sessionId: session.id, message: m.message });
        end();
      }
    }
  });
  child.on('error', (err) => {
    if (ended) return;
    end();
    broadcast('dictation:error', { sessionId: session.id, message: err.message });
  });
  child.on('close', () => {
    if (ended) return;
    end();
    // Helper vanished without a final/error — don't leave the UI stuck listening.
    broadcast('dictation:error', { sessionId: session.id, message: 'Dictation stopped unexpectedly.' });
  });

  return { ok: true };
}

/** Ask a session to finalize gracefully (emits `dictation:final`), then hard-stop as a fallback. */
export function stopDictation(opts: { sessionId: string }): void {
  const session = active;
  if (!session || session.id !== opts.sessionId) return;
  try {
    session.child.stdin.write('stop\n');
  } catch {
    teardown(session);
    return;
  }
  // The helper emits `final` and exits; if it doesn't, reap it.
  setTimeout(() => {
    if (active?.id === session.id) teardown(session);
  }, 3_000);
}

/** Kill any live session (called on app quit). */
export function stopAllDictation(): void {
  if (active) teardown(active);
}
