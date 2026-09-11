import React, { useState } from 'react';
import clsx from 'clsx';
import { FileCode2, Boxes, Zap } from 'lucide-react';
import { tryInvoke } from '../lib/api';
import { useApp } from '../store/app';
import { FolderField, finishProjectAdd, Kbd, Modal, Spinner, useProjectParentDir } from './common';

type TemplateId = 'empty' | 'next' | 'vite';

const TEMPLATES: { id: TemplateId; name: string; blurb: string; icon: React.ReactNode }[] = [
  { id: 'empty', name: 'Empty', blurb: 'Blank Git repo', icon: <FileCode2 size={22} /> },
  { id: 'next', name: 'Next.js', blurb: 'TypeScript, Tailwind, App Router', icon: <Boxes size={22} /> },
  { id: 'vite', name: 'Vite', blurb: 'React + TypeScript SPA', icon: <Zap size={22} /> },
];

/** Conductor-style "Create project": local folder + private GitHub repo + first workspace. */
export default function CreateProjectModal() {
  const setModal = useApp((s) => s.setModal);
  const toast = useApp((s) => s.toast);
  const gh = useApp((s) => s.ghAuth);
  const [name, setName] = useState('');
  const [parent, setParent] = useProjectParentDir('createParentDir');
  const [template, setTemplate] = useState<TemplateId>('empty');
  const [busy, setBusy] = useState(false);

  const close = () => setModal(null);

  const create = async () => {
    if (!name.trim() || busy) return;
    setBusy(true);
    localStorage.setItem('createParentDir', parent.trim());
    const res = await tryInvoke('project:add', {
      mode: 'quickstart',
      name: name.trim(),
      parentDir: parent.trim() || undefined,
      template,
    });
    setBusy(false);
    if (res.error) {
      toast('error', res.error);
      return;
    }
    await finishProjectAdd(res, 'Created');
  };

  const browse = async () => {
    const { data } = await tryInvoke('dialog:pickFolder');
    if (data) setParent(data);
  };

  return (
    <Modal
      plain
      title="Create project"
      onClose={close}
      width={560}
      onCmdEnter={() => void create()}
      footer={
        <button className="btn btn-accent h-8 gap-2 px-3" disabled={!name.trim() || busy} onClick={() => void create()}>
          {busy ? <Spinner className="!text-white" /> : 'Create'}
          <Kbd>⌘↵</Kbd>
        </button>
      }
    >
      <p className="text-[13px] text-muted">
        Create a local folder, {gh.authenticated ? 'private GitHub repo, ' : ''}and first workspace.
      </p>

      <div className="mt-4 space-y-4">
        <div>
          <label className="label !normal-case !text-xs !font-medium !text-fg">Project name</label>
          <input
            autoFocus
            className="input text-[13px]"
            placeholder="my-awesome-project"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void create()}
          />
        </div>

        <FolderField label="Parent folder" value={parent} onChange={setParent} onBrowse={() => void browse()} />

        <div>
          <div className="label !normal-case !text-xs !font-medium !text-fg">Template</div>
          <div className="grid grid-cols-3 gap-2.5">
            {TEMPLATES.map((t) => (
              <button
                key={t.id}
                className={clsx(
                  'flex flex-col items-center gap-2 rounded-card border px-3 py-4 text-center transition-colors',
                  template === t.id ? 'border-accent bg-accent-soft/40' : 'bg-surface hover:border-faint'
                )}
                onClick={() => setTemplate(t.id)}
              >
                <span className={clsx('flex h-11 w-11 items-center justify-center rounded-lg border bg-raised', template === t.id ? 'text-accent' : 'text-muted')}>
                  {t.icon}
                </span>
                <span className="text-[13px] font-medium">{t.name}</span>
                <span className="text-2xs leading-snug text-muted">{t.blurb}</span>
              </button>
            ))}
          </div>
        </div>

        {!gh.authenticated && (
          <p className="text-2xs text-faint">
            Not signed in to GitHub — the repo is created locally only. Sign in first to also get a private GitHub repo.
          </p>
        )}
      </div>
    </Modal>
  );
}
