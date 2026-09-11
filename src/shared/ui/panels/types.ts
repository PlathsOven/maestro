import type { DiffFile } from '../../types';

/** The workspace fields the shared workflow panels read (web-desktop-parity §10).
 *  Both apps pass an object matching this — the web's WorkspaceRow already does. */
export interface PanelWorkspace {
  id: string;
  branch: string | null;
  baseBranch: string | null;
  status: string | null;
  prNumber: number | null;
  prUrl: string | null;
  prState: string | null;
  prTitle: string | null;
  prDraft: boolean | null;
  prChecks: string | null; // 'pass' | 'fail' | 'pending' | null
  prMergeable: string | null; // 'clean' | 'conflict' | 'unknown'
  prReview: string | null;
  prChecksList: { name: string; state: string; url: string | null }[] | null;
  diffAdd: number;
  diffDel: number;
  changedFiles: number;
  git: PanelGit | null;
  statusDigest?: PanelStatusDigest | null;
  runScripts?: PanelRunScript[] | null;
  todos?: PanelTodo[] | null;
  comments?: PanelComment[] | null;
}

export interface PanelTodo {
  id: string;
  text: string;
  done: boolean;
}

export interface PanelComment {
  id: string;
  file: string;
  line: number;
  side: 'old' | 'new';
  body: string;
  resolved: boolean;
}

export interface PanelGit {
  ahead: number;
  behind: number;
  staged: number;
  unstaged: number;
  untracked: number;
  dirty: boolean;
  files?: { path: string; status: string; add: number; del: number }[];
}

export interface PanelStatusDigest {
  scope: string;
  workingOn?: string;
  lastActivity?: string;
  goal?: string;
  nextUp?: string[];
  generatedAt?: number;
  model?: string;
  stale?: boolean;
}

export interface PanelRunScript {
  id: string;
  name: string;
  kind: 'run' | 'test';
  command: string;
  state: 'idle' | 'running' | 'ok' | 'exit' | 'stopped';
  exitCode?: number;
}

export interface PanelDiff {
  base: string;
  files: DiffFile[];
}
