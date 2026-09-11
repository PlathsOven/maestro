import { useEffect, useState } from 'react';
import { ChevronRight, Folder, Plug, Plus, Server, Sparkles, Stethoscope, Trash2 } from 'lucide-react';
import { tryInvoke } from '../lib/api';
import { useApp } from '../store/app';
import { DoctorRowLine, Modal, Spinner } from './common';
import type { DoctorRow, FsEntry, SshConfigHost, SshHostConfig } from '../../shared/types';

/** uuid-ish id for a new host (main also backfills one). */
const rid = () => Math.random().toString(36).slice(2) + Date.now().toString(36);

/**
 * "Open remote folder…": pick or create an SSH host, test the connection, browse
 * the remote filesystem, and open a folder as a remote project (git detected on
 * the host). v1 auth is SSH agent or an explicit key (passphrase never stored).
 */
export default function RemoteFolderModal() {
  const setModal = useApp((s) => s.setModal);
  const toast = useApp((s) => s.toast);
  const [hosts, setHosts] = useState<SshHostConfig[]>([]);
  const [hostId, setHostId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);

  // new-host form (Key file is the default — it's what EC2 and most servers use)
  const [form, setForm] = useState<SshHostConfig>({ id: '', label: '', host: '', port: 22, user: '', auth: 'key' });
  const [passphrase, setPassphrase] = useState('');

  // hosts auto-detected from ~/.ssh/config (VS Code / Cursor / etc.)
  const [detected, setDetected] = useState<SshConfigHost[]>([]);

  // browse state
  const [cwd, setCwd] = useState('');
  const [entries, setEntries] = useState<FsEntry[] | null>(null);

  // read-only diagnostics for the connected host (host:doctor)
  const [doctorRows, setDoctorRows] = useState<DoctorRow[] | null>(null);
  const [doctoring, setDoctoring] = useState(false);

  const reload = async () => {
    const { data } = await tryInvoke('host:list');
    // Managed (Maestro Cloud) boxes and cluster nodes aren't editable here —
    // they're joined/added from Settings → Cloud (§3).
    if (data) setHosts(data.filter((h) => !h.managed && h.kind !== 'k8s'));
    return data ?? [];
  };
  useEffect(() => {
    void reload();
    void tryInvoke('host:sshConfigHosts').then(({ data }) => setDetected(data ?? []));
  }, []);

  const testAndBrowse = async (id: string, extra?: { acceptNewHostKey?: boolean; passphrase?: string }) => {
    setBusy('Connecting…');
    setEntries(null);
    setCwd('');
    setDoctorRows(null);
    const res = await tryInvoke('host:test', { hostId: id, ...extra });
    if (res.error) {
      setBusy(null);
      toast('error', res.error);
      return;
    }
    if (res.data?.needsHostKeyConfirm) {
      // First connect — TOFU. Confirm and retry (main pins on connect).
      setBusy(null);
      const ok = window.confirm('First connection to this host — accept and pin its host key?');
      if (ok) await testAndBrowse(id, { acceptNewHostKey: true, passphrase });
      return;
    }
    if (!res.data?.ok) {
      setBusy(null);
      toast('error', res.data?.error ?? 'Could not connect');
      return;
    }
    toast('success', `Connected · ${res.data.platform ?? ''} · git ${res.data.gitVersion ?? 'not found'}`);
    setHostId(id);
    // Auto-list the home directory now that we're connected (pass the id
    // explicitly — the hostId state hasn't flushed yet).
    await browse(id, '');
  };

  const browse = async (id: string, dir: string) => {
    if (!id) return;
    setBusy('Listing…');
    const { data, error } = await tryInvoke('host:browse', { hostId: id, path: dir });
    setBusy(null);
    if (error) {
      toast('error', error);
      return;
    }
    if (data) {
      setCwd(data.path);
      setEntries(data.entries);
    }
  };

  const saveNewHost = async () => {
    if (!form.host.trim() || !form.user.trim()) return toast('error', 'Host and user are required');
    const toSave: SshHostConfig = { ...form, id: form.id || rid(), label: form.label.trim() || form.host.trim() };
    const { data, error } = await tryInvoke('host:save', toSave);
    if (error || !data) return toast('error', error ?? 'Could not save host');
    await reload();
    setCreating(false);
    setHostId(data.id);
    await testAndBrowse(data.id, { passphrase: passphrase || undefined });
  };

  const removeHost = async (id: string) => {
    await tryInvoke('host:remove', { hostId: id });
    await reload();
    if (hostId === id) {
      setHostId(null);
      setEntries(null);
      setCwd('');
    }
  };

  // One-click add + connect for a host detected in ~/.ssh/config. We save the
  // alias as the `host` so SshHost re-resolves HostName/User/Port/IdentityFile
  // from the config on connect — no typing required.
  const connectDetected = async (d: SshConfigHost) => {
    const already = hosts.find((h) => h.host === d.alias || h.host === d.hostname);
    if (already) {
      setCreating(false);
      await testAndBrowse(already.id);
      return;
    }
    const toSave: SshHostConfig = {
      id: rid(),
      label: d.alias,
      host: d.alias,
      port: d.port ?? 22,
      user: d.user ?? '',
      auth: d.identityFile ? 'key' : 'agent',
      keyPath: d.identityFile,
    };
    const { data, error } = await tryInvoke('host:save', toSave);
    if (error || !data) return toast('error', error ?? 'Could not save host');
    await reload();
    setCreating(false);
    setHostId(data.id);
    await testAndBrowse(data.id);
  };

  // Detected hosts the user hasn't already saved.
  const savedHostKeys = new Set(hosts.flatMap((h) => [h.host, h.label]));
  const suggestions = detected.filter((d) => !savedHostKeys.has(d.alias) && !savedHostKeys.has(d.hostname));

  const openFolder = async () => {
    if (!hostId || !cwd || opening) return;
    setOpening(true);
    try {
      await useApp.getState().openRemoteFolder(hostId, cwd);
    } finally {
      setOpening(false);
    }
  };

  const runDoctor = async () => {
    if (!hostId || doctoring) return;
    setDoctoring(true);
    setDoctorRows(null);
    const { data, error } = await tryInvoke('host:doctor', { hostId });
    setDoctoring(false);
    if (error) return toast('error', error);
    setDoctorRows(data?.rows ?? []);
  };

  const activeHost = hosts.find((h) => h.id === hostId);

  return (
    <Modal title="Open remote folder" onClose={() => setModal(null)} width={620}>
      <div className="flex min-h-[380px] gap-3">
        {/* host list */}
        <div className="w-52 shrink-0 space-y-1 border-r pr-3">
          <div className="mb-1 text-2xs font-medium uppercase tracking-wide text-faint">SSH hosts</div>
          {hosts.map((h) => (
            <div
              key={h.id}
              className={
                'group flex items-center gap-2 rounded-ctl px-2 py-1.5 text-xs ' +
                (hostId === h.id ? 'bg-accent-soft text-accent' : 'text-muted hover:bg-accent-soft/50')
              }
            >
              <button className="flex min-w-0 flex-1 items-center gap-2 text-left" onClick={() => void testAndBrowse(h.id)}>
                <Server size={13} className="shrink-0" />
                <span className="min-w-0">
                  <span className="block truncate font-medium">{h.label}</span>
                  <span className="block truncate text-2xs text-faint">
                    {h.user}@{h.host}
                    {h.port !== 22 ? `:${h.port}` : ''}
                  </span>
                </span>
              </button>
              <button className="hidden text-faint hover:text-err group-hover:block" title="Remove host" onClick={() => void removeHost(h.id)}>
                <Trash2 size={12} />
              </button>
            </div>
          ))}
          <button
            className="flex w-full items-center gap-2 rounded-ctl px-2 py-1.5 text-xs text-muted hover:bg-accent-soft/50 hover:text-fg"
            onClick={() => {
              setCreating(true);
              setHostId(null);
              setEntries(null);
              setForm({ id: '', label: '', host: '', port: 22, user: '', auth: 'key' });
            }}
          >
            <Plus size={13} /> New host
          </button>

          {/* One-click hosts detected from ~/.ssh/config (VS Code / Cursor / etc.). */}
          {suggestions.length > 0 && (
            <div className="pt-2">
              <div className="mb-1 flex items-center gap-1 text-2xs font-medium uppercase tracking-wide text-faint">
                <Sparkles size={11} /> From ~/.ssh/config
              </div>
              {suggestions.map((d) => (
                <button
                  key={d.alias}
                  className="flex w-full items-center gap-2 rounded-ctl px-2 py-1.5 text-left text-xs text-muted hover:bg-accent-soft/50 hover:text-fg"
                  title={`Connect to ${d.user ? d.user + '@' : ''}${d.hostname}${d.port && d.port !== 22 ? ':' + d.port : ''}`}
                  onClick={() => void connectDetected(d)}
                >
                  <Server size={13} className="shrink-0 text-faint" />
                  <span className="min-w-0">
                    <span className="block truncate font-medium">{d.alias}</span>
                    <span className="block truncate text-2xs text-faint">
                      {d.user ? `${d.user}@` : ''}
                      {d.hostname}
                    </span>
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* right pane: new-host form OR browse */}
        <div className="min-w-0 flex-1">
          {creating ? (
            <div className="space-y-2.5">
              <div className="text-[13px] font-medium">New SSH host</div>
              <div className="grid grid-cols-2 gap-2">
                <Field label="Label" value={form.label} onChange={(v) => setForm({ ...form, label: v })} placeholder="my server" />
                <Field label="Host / alias" value={form.host} onChange={(v) => setForm({ ...form, host: v })} placeholder="example.com" />
                <Field label="User" value={form.user} onChange={(v) => setForm({ ...form, user: v })} placeholder="ubuntu" />
                <Field label="Port" value={String(form.port)} onChange={(v) => setForm({ ...form, port: Number(v) || 22 })} />
              </div>
              <div>
                <label className="label">Auth</label>
                <div className="flex gap-2">
                  {(['agent', 'key'] as const).map((a) => (
                    <button
                      key={a}
                      className={'btn h-7 text-xs ' + (form.auth === a ? 'btn-accent' : '')}
                      onClick={() => setForm({ ...form, auth: a })}
                    >
                      {a === 'agent' ? 'SSH agent' : 'Key file'}
                    </button>
                  ))}
                </div>
              </div>
              {form.auth === 'key' && (
                <>
                  <Field label="Key path" value={form.keyPath ?? ''} onChange={(v) => setForm({ ...form, keyPath: v })} placeholder="~/.ssh/id_ed25519" />
                  <Field label="Passphrase (not stored)" value={passphrase} onChange={setPassphrase} type="password" />
                </>
              )}
              <div className="flex justify-end gap-2 pt-1">
                <button className="btn text-xs" onClick={() => setCreating(false)}>
                  Cancel
                </button>
                <button className="btn btn-accent gap-1.5 text-xs" onClick={() => void saveNewHost()}>
                  <Plug size={12} /> Save &amp; connect
                </button>
              </div>
            </div>
          ) : activeHost ? (
            <div className="flex h-full flex-col">
              <div className="mb-2 flex items-center gap-1.5 text-2xs text-faint">
                <button className="hover:text-fg" onClick={() => void browse(activeHost.id, '')}>
                  {activeHost.user}@{activeHost.host}
                </button>
                {cwd && <ChevronRight size={11} />}
                <span className="truncate font-mono text-muted">{cwd}</span>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto rounded-ctl border">
                {busy && (
                  <div className="flex items-center gap-2 px-3 py-2 text-xs text-faint">
                    <Spinner /> {busy}
                  </div>
                )}
                {!busy && cwd && cwd !== '/' && (
                  <button
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-muted hover:bg-accent-soft/50"
                    onClick={() => void browse(activeHost.id, cwd.replace(/\/[^/]+$/, '') || '/')}
                  >
                    <Folder size={13} /> ..
                  </button>
                )}
                {!busy &&
                  entries?.map((e) => (
                    <button
                      key={e.name}
                      className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-accent-soft/50"
                      onClick={() => void browse(activeHost.id, cwd.replace(/\/$/, '') + '/' + e.name)}
                    >
                      <Folder size={13} className="text-muted" /> {e.name}
                    </button>
                  ))}
                {entries && entries.length === 0 && !busy && <div className="px-3 py-2 text-xs text-faint">No subfolders.</div>}
              </div>
              <div className="mt-2 flex items-center justify-between">
                <span className="truncate font-mono text-2xs text-faint">{cwd || 'home'}</span>
                <button className="btn btn-accent gap-1.5 text-xs" disabled={!cwd || opening} onClick={() => void openFolder()}>
                  {opening ? <Spinner className="!text-white" /> : <Folder size={12} />}
                  {opening ? 'Opening…' : 'Open this folder'}
                </button>
              </div>

              {/* Read-only remote diagnostics — env/tool/harness state to paste into a bug report. */}
              <div className="mt-3 border-t pt-2">
                <button className="btn btn-ghost gap-1.5 text-xs" disabled={doctoring} onClick={() => void runDoctor()}>
                  {doctoring ? <Spinner /> : <Stethoscope size={12} />}
                  {doctoring ? 'Running diagnostics…' : 'Run diagnostics'}
                </button>
                {doctorRows && (
                  <div className="mt-2 overflow-hidden rounded-ctl border">
                    {doctorRows.map((r) => (
                      <DoctorRowLine key={r.label} row={r} />
                    ))}
                  </div>
                )}
              </div>
            </div>
          ) : (
            <div className="flex h-full items-center justify-center text-center text-xs text-faint">
              Pick a host to browse, or add one. Agents will run on that server.
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  type,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: string;
}) {
  return (
    <div>
      <label className="label">{label}</label>
      <input className="input text-xs" type={type ?? 'text'} value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}
