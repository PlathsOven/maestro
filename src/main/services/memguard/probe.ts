import fs from 'fs';
import { run } from '../../exec';
import { descendants, parseMeminfo, parsePs, parseWindowsProbe, type MemState, type ProcInfo } from './policy';

/**
 * The memory guard's contact with the OS: read how much memory is left and who
 * holds it, and stop a process tree. No electron, no db — `scripts/memguard-e2e`
 * drives this against real processes. A light probe is the memory state alone
 * (the lazy, hours-long path); a full probe adds the process table and only runs
 * once the state is already critical.
 */

// Single-quoted strings only: the script travels as one argv entry.
const WIN_OS =
  '$os = Get-CimInstance Win32_OperatingSystem; ' +
  '$o = @{ limitKb = $os.TotalVirtualMemorySize; freeKb = $os.FreeVirtualMemory; physKb = $os.TotalVisibleMemorySize }; ';
const WIN_LIGHT = WIN_OS + '@{ os = $o } | ConvertTo-Json -Compress';
const WIN_FULL =
  WIN_OS +
  '$procs = @(Get-CimInstance Win32_Process | ForEach-Object { @{ p = $_.ProcessId; pp = $_.ParentProcessId; ' +
  'm = $_.PrivatePageCount; n = $_.Name; ' +
  'c = if ($_.CommandLine) { $_.CommandLine.Substring(0, [Math]::Min(300, $_.CommandLine.Length)) } else { $null }; ' +
  't = if ($_.CreationDate) { $_.CreationDate.ToFileTimeUtc() } else { 0 } } }); ' +
  '@{ os = $o; procs = $procs } | ConvertTo-Json -Compress -Depth 4';

export async function probe(full: boolean): Promise<{ state: MemState; procs: ProcInfo[] } | null> {
  if (process.platform === 'win32') {
    const r = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', full ? WIN_FULL : WIN_LIGHT], {
      timeout: 20_000,
    });
    return r.ok ? parseWindowsProbe(r.stdout) : null;
  }
  let state: MemState | null = null;
  try {
    state = parseMeminfo(await fs.promises.readFile('/proc/meminfo', 'utf8'));
  } catch {}
  if (!state) return null;
  if (!full) return { state, procs: [] };
  const ps = await run('ps', ['-axo', 'pid=,ppid=,rss=,etimes=,args='], { timeout: 10_000 });
  return ps.ok ? { state, procs: parsePs(ps.stdout) } : null;
}

export async function killProcessTree(victim: ProcInfo, procs: ProcInfo[]): Promise<void> {
  if (process.platform === 'win32') {
    // /T: whatever the runaway itself spawned goes with it (pytest workers).
    await run('taskkill', ['/PID', String(victim.pid), '/T', '/F'], { timeout: 15_000 });
    return;
  }
  for (const p of descendants(procs, victim.pid).reverse()) {
    try {
      process.kill(p.pid, 'SIGKILL');
    } catch {}
  }
}
