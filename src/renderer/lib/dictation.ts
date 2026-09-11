import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke, on } from './api';

// Voice dictation backed by the main process's on-device Swift helper
// (SFSpeechRecognizer, macOS). This hook only brackets a session and renders the
// transcript streamed back over IPC — no audio capture or speech engine lives in
// the renderer. Sessions are keyed by a random id so the right composer reacts
// (split view can mount more than one).

/** Whether on-device dictation can run here (macOS with a speech model). Async —
 *  the answer comes from the main process; callers gate the mic button on it. */
export async function probeDictationSupport(): Promise<{ supported: boolean; onDevice: boolean }> {
  try {
    const r = await invoke('dictation:supported');
    return { supported: r.supported, onDevice: r.onDevice };
  } catch {
    return { supported: false, onDevice: false };
  }
}

/**
 * Drive a single dictation session. `onText` streams the live transcript for a
 * preview; `onDone` fires once with the final text when recognition ends;
 * `onError` reports failures. Handlers are read through a ref, so the latest
 * closures are always used even mid-session.
 */
export function useDictation(opts: {
  onText: (transcript: string) => void;
  onDone: (finalTranscript: string) => void;
  onError: (message: string) => void;
}) {
  const optsRef = useRef(opts);
  optsRef.current = opts;
  const sessionRef = useRef<string | null>(null);
  const [listening, setListening] = useState(false);

  // Subscribe once; handlers filter to this hook's current session and read the
  // latest callbacks through the ref.
  useEffect(() => {
    const mine = (id: string) => sessionRef.current !== null && id === sessionRef.current;
    const end = () => {
      sessionRef.current = null;
      setListening(false);
    };
    const offPartial = on('dictation:partial', ({ sessionId, text }) => {
      if (mine(sessionId)) optsRef.current.onText(text);
    });
    const offFinal = on('dictation:final', ({ sessionId, text }) => {
      if (!mine(sessionId)) return;
      end();
      optsRef.current.onDone(text);
    });
    const offError = on('dictation:error', ({ sessionId, message }) => {
      if (!mine(sessionId)) return;
      end();
      if (message) optsRef.current.onError(message);
    });
    return () => {
      offPartial();
      offFinal();
      offError();
    };
  }, []);

  const start = useCallback(() => {
    if (sessionRef.current) return;
    const id = crypto.randomUUID();
    sessionRef.current = id;
    setListening(true);
    void invoke('dictation:start', { sessionId: id, lang: navigator.language || 'en-US' }).then((r) => {
      if (r.ok) return;
      if (sessionRef.current === id) {
        sessionRef.current = null;
        setListening(false);
      }
      optsRef.current.onError(r.error || 'Couldn’t start dictation.');
    });
  }, []);

  const stop = useCallback(() => {
    const id = sessionRef.current;
    if (id) void invoke('dictation:stop', { sessionId: id });
  }, []);

  // Stop the session if the composer unmounts mid-dictation.
  useEffect(
    () => () => {
      const id = sessionRef.current;
      if (id) void invoke('dictation:stop', { sessionId: id });
    },
    []
  );

  return { listening, start, stop };
}
