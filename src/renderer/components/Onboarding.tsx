import { useEffect } from 'react';
import { Folder, FolderPlus, Globe, Server, AlertTriangle, ChevronRight } from 'lucide-react';
import maestroLogo from '../assets/maestro-logo.png';
import { GitHubMark } from '../../shared/ui/brandIcons';
import { useApp } from '../store/app';
import { LiquidGlass } from '../../shared/ui/LiquidGlass';
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
      blurb: 'Open a git repo — or any folder — on this computer',
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
    <div className="wash-hero flex h-full flex-col">
      <div className="drag-region h-11 shrink-0" />
      <div className="flex flex-1 items-start justify-center overflow-y-auto px-8 pb-12 pt-4">
        <div className={showIntro ? 'my-auto w-[580px]' : 'my-auto w-[500px]'}>
          <img src={maestroLogo} alt="" className="mx-auto mb-4 h-14 w-14" />
          <h1 className="mb-3 text-center text-3xl font-semibold tracking-tight">Welcome to Maestro</h1>
          <p className="mx-auto mb-9 max-w-[440px] text-center text-[13px] leading-relaxed text-muted">
            Run a fleet of coding agents in parallel — each in an isolated git worktree with its own branch, terminal,
            and diff.
          </p>

          {showIntro && (
            <div className="mb-6">
              {showConductor && <ConductorImportPanel />}
              {showHarnessSync && (
                <div className={showConductor ? 'mt-4' : ''}>
                  <HarnessSyncPanel />
                </div>
              )}
              <div className="mb-1 mt-8 text-center text-xs font-medium text-muted">Or start fresh</div>
            </div>
          )}

          {!gh.authenticated && (
            <div className="glass mb-4 flex items-center gap-2.5 !rounded-full py-1.5 pl-3.5 pr-1.5 text-xs">
              <AlertTriangle size={14} className="shrink-0 text-warn" />
              <div className="min-w-0 flex-1 text-muted">
                {gh.installed
                  ? 'Connect GitHub to clone repos, open PRs, and see checks.'
                  : "Connect GitHub — Maestro fetches the GitHub CLI automatically if it's missing."}
              </div>
              <button className="btn shrink-0" onClick={() => void useApp.getState().startGithubSignIn()}>
                <GitHubMark size={13} />
                Sign in with GitHub
              </button>
            </div>
          )}

          <LiquidGlass radius={24} bezel={22} thickness={70} tint="strong" className="p-2">
            {options.map((o, i) => (
              <button
                key={o.title}
                className="group flex w-full items-center gap-3.5 rounded-[16px] px-3 py-3 text-left transition-colors hover:bg-accent-soft"
                onClick={o.onClick}
              >
                <span
                  className={
                    i === 0
                      ? 'flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-ink text-on-ink'
                      : 'flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent-soft text-fg'
                  }
                >
                  {o.icon}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[14px] font-medium tracking-tight">{o.title}</span>
                  <span className="block truncate text-xs text-muted">{o.blurb}</span>
                </span>
                {i === 0 ? (
                  <span className="btn btn-accent h-8 shrink-0 px-3.5">Open</span>
                ) : (
                  <ChevronRight
                    size={15}
                    className="shrink-0 text-faint transition-transform group-hover:translate-x-0.5 group-hover:text-muted"
                  />
                )}
              </button>
            ))}
          </LiquidGlass>
        </div>
      </div>
    </div>
  );
}
