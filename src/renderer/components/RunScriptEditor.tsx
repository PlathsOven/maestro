import { useEffect, useMemo, useRef, useState } from 'react';
import clsx from 'clsx';
import { Check, Copy, Pencil, Play, Sparkles, Square, Terminal as TerminalIcon, Trash2, X } from 'lucide-react';
import { extractRunCommands, parseRunDoc, isShellSegment } from '../../shared/rundoc';
import type { Workspace } from '../../shared/types';
import { tryInvoke } from '../lib/api';
import { renderMarkdown } from '../lib/format';
import { useApp } from '../store/app';
import { Segmented, Spinner } from './common';

/**
 * Full-width editor for one run script, opened by clicking its card in the Run
 * tab. Reads like an instructional document: prose explains why, and each
 * shell block is a command that really executes in the workspace terminal —
 * shown with a "runs in terminal" affordance. Edit mode is the raw markdown.
 */
export default function RunScriptEditor({ workspace, scriptId }: { workspace: Workspace; scriptId: string }) {
  const script = useApp((s) => s.runScripts[workspace.id]?.find((r) => r.id === scriptId));
  const scriptsLoaded = useApp((s) => !!s.runScripts[workspace.id]);
  const state = useApp((s) => s.runScriptStates[`${workspace.id}:${scriptId}`]);
  const running = state?.running ?? false;

  const [mode, setMode] = useState<'doc' | 'edit'>('doc');
  const [name, setName] = useState(script?.name ?? '');
  const [kind, setKind] = useState<'run' | 'test'>(script?.kind ?? 'run');
  const [doc, setDoc] = useState(script?.doc ?? '');
  const [saving, setSaving] = useState(false);
  const loadedId = useRef<string | null>(null);

  useEffect(() => {
    if (!scriptsLoaded) void useApp.getState().loadRunScripts(workspace.id);
  }, [scriptsLoaded, workspace.id]);

  // Seed local state once per script; external updates only flow in while clean.
  const dirty = !!script && (name !== script.name || kind !== script.kind || doc !== script.doc);
  useEffect(() => {
    if (!script) return;
    if (loadedId.current !== script.id || !dirty) {
      loadedId.current = script.id;
      setName(script.name);
      setKind(script.kind);
      setDoc(script.doc);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [script?.id, script?.updatedAt]);

  const close = () => useApp.getState().setEditingScript(workspace.id, null);

  const save = async (): Promise<boolean> => {
    if (!script || !dirty) return true;
    setSaving(true);
    const { error } = await tryInvoke('runscript:update', {
      scriptId: script.id,
      patch: { name: name.trim() || script.name, kind, doc },
    });
    setSaving(false);
    if (error) {
      useApp.getState().toast('error', error);
      return false;
    }
    return true;
  };

  const saveAndClose = async () => {
    if (await save()) close();
  };

  const remove = () => {
    if (!script) return;
    useApp.getState().setModal({
      kind: 'confirm',
      title: 'Delete run script',
      body: `Delete “${script.name}”? This removes it from this workspace's Run tab.`,
      confirmLabel: 'Delete',
      danger: true,
      onConfirm: () => {
        void tryInvoke('runscript:delete', { scriptId: script.id });
        close();
      },
    });
  };

  const commands = useMemo(() => extractRunCommands(doc), [doc]);

  if (!script) {
    return (
      <div className="flex h-full items-center justify-center text-xs text-muted">
        {scriptsLoaded ? (
          <div className="space-y-2 text-center">
            <div>This script no longer exists.</div>
            <button className="btn h-7 text-xs" onClick={close}>
              Back
            </button>
          </div>
        ) : (
          <Spinner />
        )}
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      {/* header */}
      <div className="flex shrink-0 items-center gap-2 border-b px-4 py-2">
        <button className="rounded-ctl p-1.5 text-muted hover:bg-accent-soft hover:text-fg" title="Close (saves changes)" onClick={() => void saveAndClose()}>
          <X size={14} />
        </button>
        <input
          className="min-w-0 flex-1 bg-transparent text-[13px] font-semibold outline-none placeholder:text-faint"
          value={name}
          placeholder="Script name"
          onChange={(e) => setName(e.target.value)}
        />
        <Segmented<'run' | 'test'>
          value={kind}
          options={[
            { value: 'run', label: 'Run' },
            { value: 'test', label: 'Test' },
          ]}
          onChange={setKind}
        />
        <Segmented<'doc' | 'edit'>
          value={mode}
          options={[
            { value: 'doc', label: 'Doc' },
            { value: 'edit', label: <span className="flex items-center gap-1"><Pencil size={10} /> Edit</span> },
          ]}
          onChange={setMode}
        />
        {dirty && (
          <button className="btn h-7 px-2.5 text-xs" disabled={saving} onClick={() => void save()}>
            {saving ? <Spinner /> : 'Save'}
          </button>
        )}
        <button
          className={clsx('btn h-7 gap-1.5 px-2.5 text-xs', !running && 'btn-accent')}
          title={
            running
              ? 'Stop this script'
              : `Run all shell blocks in this workspace (WORKSPACE_PORT=${workspace.port})`
          }
          disabled={!running && !commands}
          onClick={() => {
            if (running) useApp.getState().stopRunScript(workspace.id, script.id);
            else {
              // Run what's on screen: persist edits first, then execute.
              void save().then((ok) => {
                if (ok) void useApp.getState().execRunScript(workspace.id, script.id);
              });
            }
          }}
        >
          {running ? <Square size={11} fill="currentColor" /> : <Play size={11} />}
          {running ? 'Stop' : 'Run'}
        </button>
        <button className="rounded-ctl p-1.5 text-muted hover:bg-accent-soft hover:text-err" title="Delete script" onClick={remove}>
          <Trash2 size={13} />
        </button>
      </div>

      {/* body */}
      {mode === 'doc' ? (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto max-w-3xl space-y-3 px-6 py-5">
            <div className="flex items-center gap-2 text-2xs text-faint">
              {script.source === 'ai' && (
                <span className="flex items-center gap-1">
                  <Sparkles size={10} /> AI-detected —
                </span>
              )}
              <span>
                Prose is documentation; every shell block below executes in this workspace's terminal, top to
                bottom. <span className="font-mono">WORKSPACE_PORT={workspace.port}</span>
              </span>
            </div>
            {parseRunDoc(doc).map((seg, i) =>
              seg.kind === 'prose' ? (
                <div key={i} className="md text-[13px]" dangerouslySetInnerHTML={{ __html: renderMarkdown(seg.text) }} />
              ) : (
                <CommandBlock key={i} code={seg.code} executable={isShellSegment(seg)} />
              )
            )}
            {parseRunDoc(doc).length === 0 && (
              <div className="rounded-card border border-dashed px-4 py-6 text-center text-xs text-muted">
                Empty script — switch to Edit and add commands.
              </div>
            )}
          </div>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">
          <textarea
            className="min-h-0 flex-1 resize-none bg-transparent px-6 py-5 font-mono text-xs leading-relaxed outline-none"
            value={doc}
            spellCheck={false}
            onChange={(e) => setDoc(e.target.value)}
            placeholder={'Explain the why in prose, put each command in a ```sh block…'}
          />
          <div className="shrink-0 border-t px-6 py-2 text-2xs text-faint">
            Markdown. Each <span className="font-mono">```sh</span> code block runs in the workspace terminal, in
            order; a failing block stops the rest. Prose in between is documentation for you and your team.
          </div>
        </div>
      )}
    </div>
  );
}

/** One executable command block: monospace card with a "runs in terminal" chip
 *  and copy button — the doc's promise that this exact text is what executes. */
function CommandBlock({ code, executable }: { code: string; executable: boolean }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard?.writeText(code).catch(() => {});
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1400);
  };
  return (
    <div className="overflow-hidden rounded-card border" style={{ background: 'var(--term-bg)' }}>
      <div className="flex items-center gap-1.5 border-b px-3 py-1">
        <TerminalIcon size={11} className="text-faint" />
        <span className="text-2xs text-faint">{executable ? 'runs in terminal' : 'reference only (not executed)'}</span>
        <div className="flex-1" />
        <button className="rounded p-0.5 text-faint hover:text-fg" title="Copy" onClick={copy}>
          {copied ? <Check size={11} className="text-ok" /> : <Copy size={11} />}
        </button>
      </div>
      <pre className="overflow-x-auto px-3 py-2.5 font-mono text-xs leading-relaxed">
        {code.split('\n').map((line, i) => (
          <div key={i} className="flex">
            {executable && !line.trim().startsWith('#') && line.trim() ? (
              <span className="mr-2 select-none text-accent">$</span>
            ) : (
              <span className="mr-2 select-none opacity-0">$</span>
            )}
            <span className={clsx(line.trim().startsWith('#') && 'text-faint')}>{line || ' '}</span>
          </div>
        ))}
      </pre>
    </div>
  );
}
