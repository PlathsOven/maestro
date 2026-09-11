import { useEffect } from 'react';
import { Folder, FolderPlus, Globe, Server, AlertTriangle, ChevronRight } from 'lucide-react';
import { useApp } from '../store/app';
import ConductorImportPanel from './ConductorImportPanel';
import HarnessSyncPanel from './HarnessSyncPanel';

export default function Onboarding() {
  const gh = useApp((s) => s.ghAuth);
  const setModal = useApp((s) => s.setModal);
  const detected = useApp((s) => s.conductorDetected);
  const scanning = useApp((s) => s.conductorScanning);
  const scanError = useApp((s) => s.conductorScanError);
  const conductorScan = useApp((s) => s.conductorScan);
  const hsDetected = useApp((s) => s.harnessSyncDetected);
  const hsScanning = useApp((s) => s.harnessSyncScanning);
  const hsScanError = useApp((s) => s.harnessSyncScanError);
  const hsScan = useApp((s) => s.harnessSyncScan);

  // Kick the scans when the gate mounts too — resilient if the init-time scan was
  // missed or is still in flight; both are no-ops when already cached.
  useEffect(() => {
    void useApp.getState().scanConductor();
    void useApp.getState().scanHarnessSync();
  }, []);

  // Reserve the section the instant Conductor is detected (before the full scan
  // lands) so the user gets immediate "loading" feedback. Once the scan resolves
  // with nothing importable, it collapses away.
  const hasImportable = conductorScan?.projects.some((p) => !p.missing && !p.alreadyImported) ?? false;
  const showConductor = detected && (scanning || !conductorScan || !!scanError || hasImportable);
  const hasImportableHs = hsScan?.groups.some((g) => g.sessions.some((s) => !s.alreadyImported)) ?? false;
  const showHarnessSync = hsDetected && (hsScanning || !hsScan || !!hsScanError || hasImportableHs);
  const showIntro = showConductor || showHarnessSync;

  const options = [
    {
      icon: <Folder size={17} />,
      title: 'Open project',
      blurb: 'Open a git repo — or any folder — on this Mac',
      onClick: () => void useApp.getState().openLocalProject(),
    },
    {
      icon: <Globe size={17} />,
      title: 'Open GitHub project',
      blurb: 'Clone one of your repos',
      onClick: () => setModal({ kind: 'clone-repo' }),
    },
    {
      icon: <Server size={17} />,
      title: 'Open remote folder',
      blurb: 'SSH into a server and work in a folder there',
      onClick: () => setModal({ kind: 'remote-folder' }),
    },
    {
      icon: <FolderPlus size={17} />,
      title: 'Quick start',
      blurb: 'Local folder, private GitHub repo, and first workspace',
      onClick: () => setModal({ kind: 'create-project' }),
    },
  ];

  return (
    <div className="flex h-full flex-col bg-bg">
      <div className="drag-region h-11 shrink-0" />
      <div className="flex flex-1 items-start justify-center overflow-y-auto p-8">
        <div className={showIntro ? 'my-auto w-[560px]' : 'my-auto w-[460px]'}>
          <div className="mb-1 text-center text-2xl font-semibold tracking-tight">Maestro</div>
          <div className="mb-8 text-center text-[13px] text-muted">
            Run a fleet of coding agents in parallel — each in an isolated git worktree with its own branch, terminal,
            and diff.
          </div>

          {showIntro && (
            <div className="mb-6">
              {showConductor && <ConductorImportPanel />}
              {showHarnessSync && (
                <div className={showConductor ? 'mt-4' : ''}>
                  <HarnessSyncPanel />
                </div>
              )}
              <div className="mt-6 mb-3 flex items-center gap-3 text-2xs uppercase tracking-wide text-faint">
                <div className="h-px flex-1 bg-line" />
                Or start fresh
                <div className="h-px flex-1 bg-line" />
              </div>
            </div>
          )}

          {!gh.authenticated && (
            <div className="mb-4 flex items-center gap-2.5 rounded-card border border-warn/40 bg-warn/10 px-3 py-2.5 text-xs">
              <AlertTriangle size={14} className="shrink-0 text-warn" />
              <div className="flex-1">
                {gh.installed
                  ? 'Connect GitHub to clone repos, open PRs, and see checks.'
                  : "Connect GitHub — Maestro fetches the GitHub CLI automatically if it's missing."}
              </div>
              <button
                className="btn btn-accent h-6 shrink-0 text-2xs"
                onClick={() => void useApp.getState().startGithubSignIn()}
              >
                Sign in with GitHub
              </button>
            </div>
          )}

          <div className="card overflow-hidden">
            {options.map((o, i) => (
              <button
                key={o.title}
                className={`flex w-full items-center gap-3.5 px-4 py-3.5 text-left transition-colors hover:bg-accent-soft ${
                  i > 0 ? 'border-t' : ''
                }`}
                onClick={o.onClick}
              >
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border bg-raised text-accent">
                  {o.icon}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[14px] font-medium">{o.title}</span>
                  <span className="block truncate text-xs text-muted">{o.blurb}</span>
                </span>
                <ChevronRight size={15} className="shrink-0 text-faint" />
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
