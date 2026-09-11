'use client';
import React from 'react';

/**
 * The one seam through which host-specific behaviour reaches the shared UI
 * (web-desktop-parity spec §2.4). Shared components never import the store, the
 * IPC bridge, `next/*` or node — anything a host must do (open a file, resolve a
 * worktree image, copy text, raise a toast) is injected here. The desktop
 * provides it in src/renderer/App.tsx; the web in web/app/layout.tsx.
 */
export interface UiHost {
  /** Open a repo-relative file (optionally at a line). Undefined ⇒ file links
   *  render as plain `<code>` (web). */
  openFile?: (path: string, line?: number) => void;
  /** Resolve an attachment/image reference to a URL. Undefined ⇒ AttachmentChip
   *  shows the filename only. */
  imageSrc?: (ref: string) => string | undefined;
  /** Imperative post-render pass over a rendered-markdown subtree. The desktop
   *  wires this to its worktree-image loader + in-app file-link opener
   *  (useWorktreeImages), so agent screenshots and file links keep working
   *  exactly as before. Runs after every render (markdown is rebuilt each time);
   *  return a cleanup to detach listeners. Undefined ⇒ the shared Markdown falls
   *  back to `imageSrc` for images and neutralises relative links (web). */
  hydrateMarkdown?: (root: HTMLElement) => (() => void) | void;
  copyText: (text: string) => Promise<void>;
  toast: (t: {
    kind: 'error' | 'info' | 'success';
    text: string;
    actions?: { label: string; onClick: () => void }[];
  }) => void;
  /** Coarse pointer (touch). Components use it to swap hover-revealed actions for
   *  always-visible ones, and to flip the composer's Enter-key behaviour. */
  isTouch: boolean;
}

const defaultHost: UiHost = {
  copyText: async (text) => {
    try {
      await navigator.clipboard?.writeText(text);
    } catch {
      /* no clipboard available (or denied) — nothing else to fall back to here */
    }
  },
  toast: (t) => {
    // No host wired a real toaster — surface it somewhere rather than swallow it.
    // eslint-disable-next-line no-console
    console[t.kind === 'error' ? 'error' : 'log'](`[toast:${t.kind}]`, t.text);
  },
  isTouch: false,
};

export const UiHostContext = React.createContext<UiHost>(defaultHost);

export function UiHostProvider({ host, children }: { host: UiHost; children: React.ReactNode }) {
  return <UiHostContext.Provider value={host}>{children}</UiHostContext.Provider>;
}

export const useUiHost = (): UiHost => React.useContext(UiHostContext);
