import { useEffect, useMemo } from 'react';
import { on } from './lib/api';
import { useApp, useActiveWorkspace, capsOf } from './store/app';
import { UiHostProvider, type UiHost } from '../shared/ui/host';
import { hydrateChatMarkdown } from './lib/worktreeImages';
import Sidebar from './components/Sidebar';
import Onboarding from './components/Onboarding';
import SetupWizard from './components/SetupWizard';
import WorkspaceView from './components/WorkspaceView';
import WorkspacesView from './components/WorkspacesView';
import RightPanel from './components/RightPanel';
import Toasts from './components/Toasts';
import UpdateToast from './components/UpdateToast';
import CommandPalette from './components/CommandPalette';
import CloneRepoModal from './components/CloneRepoModal';
import CreateProjectModal from './components/CreateProjectModal';
import RemoteFolderModal from './components/RemoteFolderModal';
import NewWorkspaceModal from './components/NewWorkspaceModal';
import ConductorImportPanel from './components/ConductorImportPanel';
import HarnessSyncPanel from './components/HarnessSyncPanel';
import SettingsModal from './components/SettingsModal';
import GitHubSignInModal from './components/GitHubSignInModal';
import SubagentPreview from './components/SubagentPreview';
import ImageLightbox from './components/ImageLightbox';
import { Modal, EmptyHint } from './components/common';
import { Boxes } from 'lucide-react';

/**
 * Provides the shared-UI host (web-desktop-parity §2.4) once at the root, so the
 * shared transcript / composer / markdown reach the desktop's file opener,
 * worktree-image loader, clipboard and toasts without importing the store.
 */
export default function App() {
  const uiHost = useMemo<UiHost>(
    () => ({
      openFile: (path) => {
        const s = useApp.getState();
        if (s.activeWorkspaceId) s.openFile(s.activeWorkspaceId, path);
      },
      hydrateMarkdown: hydrateChatMarkdown,
      copyText: async (text) => {
        try {
          await navigator.clipboard.writeText(text);
        } catch {
          /* clipboard unavailable */
        }
      },
      toast: (t) => useApp.getState().toast(t.kind, t.text),
      isTouch: false,
    }),
    []
  );
  return (
    <UiHostProvider host={uiHost}>
      <AppInner />
    </UiHostProvider>
  );
}

function AppInner() {
  const loaded = useApp((s) => s.loaded);
  const onboarded = useApp((s) => s.settings.onboarded);
  const projects = useApp((s) => s.projects);
  const modal = useApp((s) => s.modal);
  const showWorkspaces = useApp((s) => s.showWorkspaces);
  const activeWs = useActiveWorkspace();

  useEffect(() => {
    void useApp.getState().init();
  }, []);

  // Legacy chord kept working alongside the ⌘N menu accelerator.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === 'n' && e.metaKey && e.shiftKey) {
        e.preventDefault();
        const s = useApp.getState();
        // Folder projects have no worktrees — ⌘⇧N opens a new chat instead.
        if (s.activeProjectId && capsOf(s, s.activeProjectId).worktrees) s.setModal({ kind: 'new-workspace' });
        else if (s.activeWorkspaceId) {
          s.setTab(s.activeWorkspaceId, 'chat');
          s.newChat(s.activeWorkspaceId);
        } else s.setProjectsMenu(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    return on('menu:action', ({ action }) => {
      const s = useApp.getState();
      const wsId = s.activeWorkspaceId;
      if (action === 'settings') s.setModal({ kind: 'settings' });
      else if (action === 'open-project') void s.openLocalProject();
      else if (action === 'clone-repo') s.setModal({ kind: 'clone-repo' });
      else if (action === 'create-project') s.setModal({ kind: 'create-project' });
      else if (action === 'projects-menu') s.setProjectsMenu(true);
      else if (action === 'new-workspace') {
        // Folder projects have no worktrees — fall back to a new chat.
        if (s.activeProjectId && capsOf(s, s.activeProjectId).worktrees) s.setModal({ kind: 'new-workspace' });
        else if (wsId) {
          s.setTab(wsId, 'chat');
          s.newChat(wsId);
        } else s.setProjectsMenu(true);
      } else if (action === 'new-chat' && wsId) {
        s.setTab(wsId, 'chat');
        s.newChat(wsId);
      } else if (action === 'close-tab' && wsId) {
        // ⌘W follows the active center surface: an editor tab when the Editor is
        // up (dirty-guarded inside EditorSurface via the nonce), else a chat tab.
        if ((s.tabByWs[wsId] ?? 'chat') === 'editor' && s.activeFile[wsId]) s.requestCloseActiveFile();
        else s.closeActiveChat(wsId);
      } else if (action === 'reopen-tab' && wsId) {
        // ⇧⌘T likewise: reopen the last closed editor tab in Editor mode, else chat.
        if ((s.tabByWs[wsId] ?? 'chat') === 'editor') s.reopenClosedFile(wsId);
        else s.reopenClosedTab(wsId);
      } else if (action === 'palette') s.setPalette(!s.paletteOpen);
      else if (action === 'toggle-theme') void s.saveSettings({ theme: s.resolvedTheme === 'dark' ? 'light' : 'dark' });
      else if (action === 'github-signin') void s.startGithubSignIn();
      else if (action === 'focus-composer' && wsId) {
        s.setTab(wsId, 'chat');
        s.focusComposer();
      } else if (action === 'tab-chat' && wsId) {
        s.setTab(wsId, 'chat');
        s.focusComposer();
      } else if (action === 'tab-diff' && wsId) {
        // toggle diff review mode (git projects only — folders have no diff)
        const caps = capsOf(s, s.workspaces.find((w) => w.id === wsId)?.projectId);
        if (caps.git) s.setTab(wsId, (s.tabByWs[wsId] ?? 'chat') === 'diff' ? 'chat' : 'diff');
      } else if (action === 'tab-editor' && wsId) {
        // Toggle the Editor surface — only meaningful once a file is open.
        if ((s.openFiles[wsId] ?? []).length > 0) {
          s.setTab(wsId, (s.tabByWs[wsId] ?? 'chat') === 'editor' ? 'chat' : 'editor');
        }
      } else if (action === 'tab-preview' && wsId) {
        // Toggle the embedded Preview surface (opening the live view on entry).
        if ((s.tabByWs[wsId] ?? 'chat') === 'preview') s.setTab(wsId, 'chat');
        else s.openPreview(wsId);
      } else if (action === 'tab-terminal' && wsId) {
        s.openDockTerminal(wsId);
      } else if (action === 'tab-checks' && wsId) {
        const caps = capsOf(s, s.workspaces.find((w) => w.id === wsId)?.projectId);
        if (caps.githubRemote && s.ghAuth.authenticated) s.setRightTab(wsId, 'checks');
      } else if (action === 'create-pr' && wsId) {
        const caps = capsOf(s, s.workspaces.find((w) => w.id === wsId)?.projectId);
        if (caps.githubRemote && s.ghAuth.authenticated) void s.createPr(wsId);
      }
      else if (action === 'archive' && wsId) {
        const ws = s.workspaces.find((w) => w.id === wsId);
        s.setModal({
          kind: 'confirm',
          title: 'Archive workspace',
          body: `Archive "${ws?.name}"? It moves to History; the worktree stays on disk and chat history is kept.`,
          confirmLabel: 'Archive',
          onConfirm: () => void s.archiveWorkspace(wsId),
        });
      } else if (action.startsWith('workspace-')) {
        const idx = parseInt(action.split('-')[1], 10) - 1;
        const list = s.workspaces.filter((w) => w.projectId === s.activeProjectId && !w.archived);
        if (list[idx]) s.selectWorkspace(list[idx].id);
      }
    });
  }, []);

  if (!loaded) {
    return (
      <div className="flex h-full items-center justify-center bg-bg">
        <div className="text-sm text-muted">Loading Maestro…</div>
      </div>
    );
  }

  // First-run setup (connect agent CLIs + a quick tour) precedes the project
  // picker; it flips settings.onboarded exactly once per install.
  if (!onboarded) {
    return (
      <>
        <SetupWizard />
        <PreAppModals />
      </>
    );
  }

  if (projects.length === 0) {
    return (
      <>
        <Onboarding />
        <PreAppModals />
        {modal?.kind === 'folder-choice' && <FolderChoiceModal />}
        {modal?.kind === 'remote-folder' && <RemoteFolderModal />}
      </>
    );
  }

  return (
    <div className="flex h-full bg-bg">
      <Sidebar />
      <main className="flex min-w-0 flex-1 flex-col border-l">
        {showWorkspaces ? (
          <WorkspacesView />
        ) : activeWs ? (
          <WorkspaceView key={activeWs.id} workspace={activeWs} />
        ) : (
          <div className="flex h-full flex-col">
            <div className="drag-region h-11 shrink-0" />
            <EmptyHint
              icon={<Boxes size={32} strokeWidth={1.5} />}
              title="No workspace selected"
              body="Create a workspace to spin up an isolated git worktree with its own branch, terminal, and agent."
              action={
                <button className="btn btn-accent no-drag" onClick={() => useApp.getState().setModal({ kind: 'new-workspace' })}>
                  New workspace
                </button>
              }
            />
          </div>
        )}
      </main>
      {activeWs && !showWorkspaces && <RightPanel workspace={activeWs} />}

      <CommandPalette />
      <Toasts />
      <UpdateToast />
      {modal?.kind === 'clone-repo' && <CloneRepoModal />}
      {modal?.kind === 'create-project' && <CreateProjectModal />}
      {modal?.kind === 'new-workspace' && <NewWorkspaceModal />}
      {modal?.kind === 'settings' && <SettingsModal />}
      {modal?.kind === 'github-signin' && <GitHubSignInModal />}
      {modal?.kind === 'confirm' && <ConfirmModal />}
      {modal?.kind === 'branch-conflict' && <BranchConflictModal />}
      {modal?.kind === 'folder-choice' && <FolderChoiceModal />}
      {modal?.kind === 'remote-folder' && <RemoteFolderModal />}
      {modal?.kind === 'conductor-import' && <ConductorImportModal />}
      {modal?.kind === 'harness-sync' && <HarnessSyncModal />}
      {modal?.kind === 'subagent-preview' && <SubagentPreview />}
      <ImageLightbox />
    </div>
  );
}

/** Toasts + update banner + pre-project modals, shared by the onboarding and
 *  empty-project gates (the main app renders its own superset inline). */
function PreAppModals() {
  const modal = useApp((s) => s.modal);
  return (
    <>
      <Toasts />
      <UpdateToast />
      {modal?.kind === 'settings' && <SettingsModal />}
      {modal?.kind === 'github-signin' && <GitHubSignInModal />}
      {modal?.kind === 'clone-repo' && <CloneRepoModal />}
      {modal?.kind === 'create-project' && <CreateProjectModal />}
    </>
  );
}

/** Post-onboarding "Import from Conductor…" — the same panel as the gate, in a
 *  modal (opened from the sidebar + menu and the command palette). */
function ConductorImportModal() {
  const setModal = useApp((s) => s.setModal);
  return (
    <Modal title="Continue from Conductor" onClose={() => setModal(null)} width={580}>
      <ConductorImportPanel hideTitle />
    </Modal>
  );
}

/** "Sync chats from Claude Code & Codex" — the same panel as the onboarding gate,
 *  in a modal (opened from the sidebar menu, command palette, and Settings). */
function HarnessSyncModal() {
  const setModal = useApp((s) => s.setModal);
  return (
    <Modal title="Sync chats from Claude Code & Codex" onClose={() => setModal(null)} width={600}>
      <HarnessSyncPanel hideTitle />
    </Modal>
  );
}

/** After picking a non-git folder in "Open project": work in it directly (a
 *  folder project) or turn it into a git repo. (§4) */
function FolderChoiceModal() {
  const modal = useApp((s) => s.modal);
  const setModal = useApp((s) => s.setModal);
  if (modal?.kind !== 'folder-choice') return null;
  const folder = modal.path;
  const name = folder.split(/[\\/]/).filter(Boolean).pop() ?? folder;
  const choose = (initGit: boolean) => {
    setModal(null);
    void useApp.getState().addFolderProject(folder, initGit);
  };
  return (
    <Modal title="This folder isn’t a git repository" onClose={() => setModal(null)} width={520}>
      <div className="space-y-3 text-[13px] text-muted">
        <p>
          <code className="font-mono text-xs">{name}</code> isn’t a git repository. Choose how to open it:
        </p>
        <button
          className="w-full rounded-card border p-3 text-left transition-colors hover:border-accent/50 hover:bg-accent-soft/40"
          onClick={() => choose(false)}
        >
          <div className="text-[13px] font-medium text-fg">Work in this folder</div>
          <div className="mt-0.5 text-2xs text-faint">
            Agents edit the folder directly — no branches, diffs, or PRs.
          </div>
        </button>
        <button
          className="w-full rounded-card border p-3 text-left transition-colors hover:border-accent/50 hover:bg-accent-soft/40"
          onClick={() => choose(true)}
        >
          <div className="text-[13px] font-medium text-fg">Initialize git here</div>
          <div className="mt-0.5 text-2xs text-faint">
            Creates a repo and a first commit — committing this folder’s current contents — so you get isolated
            workspaces, diffs, and checkpoints. Check for large files or secrets first.
          </div>
        </button>
      </div>
    </Modal>
  );
}

function ConfirmModal() {
  const modal = useApp((s) => s.modal);
  const setModal = useApp((s) => s.setModal);
  if (modal?.kind !== 'confirm') return null;
  return (
    <Modal
      title={modal.title}
      onClose={() => setModal(null)}
      width={440}
      footer={
        <>
          <button className="btn" onClick={() => setModal(null)}>
            Cancel
          </button>
          <button
            className={modal.danger ? 'btn btn-danger' : 'btn btn-accent'}
            onClick={() => {
              setModal(null);
              modal.onConfirm();
            }}
          >
            {modal.confirmLabel}
          </button>
        </>
      }
    >
      <div className="text-[13px] text-muted">{modal.body}</div>
    </Modal>
  );
}

function BranchConflictModal() {
  const modal = useApp((s) => s.modal);
  const setModal = useApp((s) => s.setModal);
  const toast = useApp((s) => s.toast);
  if (modal?.kind !== 'branch-conflict') return null;
  const suffixed = `${modal.branch}-2`;
  return (
    <Modal
      title="Branch already checked out"
      onClose={() => setModal(null)}
      width={480}
      footer={
        <>
          <button className="btn" onClick={() => setModal(null)}>
            Cancel
          </button>
          <button
            className="btn btn-accent"
            onClick={async () => {
              setModal(null);
              const { tryInvoke } = await import('./lib/api');
              const res = await tryInvoke('workspace:switchBranch', {
                workspaceId: modal.workspaceId,
                branch: suffixed,
                create: true,
              });
              if (res.error || !res.data?.ok) toast('error', res.error ?? res.data?.conflict ?? 'Failed');
              else toast('success', `Created and switched to ${suffixed}`);
            }}
          >
            Create {suffixed}
          </button>
        </>
      }
    >
      <div className="space-y-2 text-[13px] text-muted">
        <p>
          <code className="font-mono text-xs">{modal.branch}</code> is already checked out in another worktree — git
          enforces one branch per worktree.
        </p>
        <p>
          You can branch off it instead: <code className="font-mono text-xs">git checkout -b {suffixed} {modal.branch}</code>
        </p>
        <p className="text-2xs text-faint">{modal.message}</p>
      </div>
    </Modal>
  );
}
