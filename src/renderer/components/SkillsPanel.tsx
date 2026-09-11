import { useEffect, useMemo, useState } from 'react';
import clsx from 'clsx';
import { Blocks, Plus, Search } from 'lucide-react';
import { tryInvoke } from '../lib/api';
import { useApp } from '../store/app';
import { Modal, Segmented, Spinner } from './common';
import type { SkillEntry, SkillLocation, Workspace } from '../../shared/types';

/**
 * Right-panel Skills tab: every skill the workspace's harness can invoke via
 * /name — personal (~ config), project (committed in the worktree), and
 * plugin-shipped (read-only). "+" opens a markdown editor; saving writes the
 * file where the CLI discovers it, so the skill works on the very next send.
 */
export default function SkillsPanel({ workspace }: { workspace: Workspace }) {
  const skills = useApp((s) => s.skills[workspace.id]);
  const wsVersion = useApp((s) => s.wsVersion[workspace.id] ?? 0);
  const [query, setQuery] = useState('');
  // null = closed · {skill:null} = create · {skill} = view/edit
  const [editor, setEditor] = useState<{ skill: SkillEntry | null } | null>(null);

  // wsVersion bumps as the worktree changes, so skills an agent just wrote
  // into .claude/skills (etc.) appear without a manual refresh.
  useEffect(() => {
    void useApp.getState().loadSkills(workspace.id);
  }, [workspace.id, wsVersion]);

  const filtered = useMemo(() => {
    if (!skills) return [];
    const q = query.trim().toLowerCase();
    if (!q) return skills;
    return skills.filter(
      (s) => s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q)
    );
  }, [skills, query]);

  return (
    <div className="space-y-3 px-3 py-3">
      <div className="flex items-center gap-2">
        <div className="flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded-ctl border bg-raised px-2 transition-colors focus-within:border-accent">
          <Search size={12} className="shrink-0 text-faint" />
          <input
            className="w-full bg-transparent text-xs outline-none placeholder:text-faint"
            placeholder="Search skills…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <button className="btn h-7 w-7 !px-0" title="New skill" onClick={() => setEditor({ skill: null })}>
          <Plus size={14} />
        </button>
      </div>

      <div className="px-1 text-2xs text-faint">
        Type <span className="font-mono">/</span> in the chat box to run a skill. Personal skills work in every
        workspace; project skills ship with this repo.
      </div>

      {!skills ? (
        <div className="flex justify-center py-8">
          <Spinner />
        </div>
      ) : filtered.length === 0 ? (
        <div className="rounded-card border border-dashed px-4 py-8 text-center">
          <Blocks size={18} className="mx-auto mb-2 text-faint" />
          <div className="text-xs text-muted">
            {skills.length === 0 ? (
              <>
                No skills yet — click <Plus size={11} className="inline" /> to create your first one.
              </>
            ) : (
              'No skills match your search.'
            )}
          </div>
        </div>
      ) : (
        <div className="overflow-hidden rounded-card border bg-surface">
          {filtered.map((s) => (
            <button
              key={s.path}
              className="block w-full border-b px-2.5 py-2 text-left last:border-b-0 hover:bg-accent-soft/50"
              title={s.source === 'plugin' ? 'View skill (plugin — read-only)' : 'View / edit skill'}
              onClick={() => setEditor({ skill: s })}
            >
              <span className="flex items-center gap-1.5">
                <span className="font-mono text-xs text-faint">/</span>
                <span className="min-w-0 truncate text-[13px] font-medium">{s.name}</span>
                <span
                  className={clsx(
                    'ml-auto shrink-0 rounded-full px-1.5 py-px text-2xs',
                    s.source === 'project' ? 'bg-accent-soft text-accent' : 'bg-border text-muted'
                  )}
                >
                  {s.source === 'plugin' ? s.plugin : s.source === 'project' ? 'project' : 'personal'}
                </span>
              </span>
              {s.description && <span className="mt-0.5 line-clamp-2 block text-xs text-muted">{s.description}</span>}
            </button>
          ))}
        </div>
      )}

      {editor && <SkillEditor workspace={workspace} skill={editor.skill} onClose={() => setEditor(null)} />}
    </div>
  );
}

const TEMPLATE = `---
name: my-skill
description: One line shown in the / menu — what this skill does and when to use it
---

Instructions the agent follows when you send /my-skill.

Write them like you'd brief a teammate: the steps to take, commands to run,
and what "done" looks like.
`;

/**
 * Markdown editor for one skill. The frontmatter \`name:\` becomes the
 * /command and the file location, so it's required; everything else is free-form.
 */
function SkillEditor({
  workspace,
  skill,
  onClose,
}: {
  workspace: Workspace;
  skill: SkillEntry | null;
  onClose: () => void;
}) {
  const isNew = !skill;
  const readOnly = skill?.source === 'plugin';
  const [location, setLocation] = useState<SkillLocation>(skill?.source === 'project' ? 'project' : 'user');
  const [markdown, setMarkdown] = useState<string | null>(isNew ? TEMPLATE : null);
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    if (!skill) return;
    void tryInvoke('skill:read', { workspaceId: workspace.id, path: skill.path }).then(({ data, error }) => {
      if (error) {
        useApp.getState().toast('error', error);
        onClose();
      } else {
        setMarkdown(data!.markdown);
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const save = async () => {
    if (readOnly || markdown === null || saving) return;
    setSaving(true);
    const { data, error } = await tryInvoke('skill:save', {
      workspaceId: workspace.id,
      location,
      markdown,
      prevPath: skill && skill.source !== 'plugin' ? skill.path : undefined,
    });
    setSaving(false);
    if (error) {
      useApp.getState().toast('error', error);
      return;
    }
    useApp.getState().toast('success', `Skill /${data!.name} saved — ready on your next message`);
    void useApp.getState().loadSkills(workspace.id);
    onClose();
  };

  const remove = async () => {
    if (!skill || readOnly) return;
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    const { error } = await tryInvoke('skill:delete', { workspaceId: workspace.id, path: skill.path });
    if (error) {
      useApp.getState().toast('error', error);
      return;
    }
    useApp.getState().toast('success', `Deleted /${skill.name}`);
    void useApp.getState().loadSkills(workspace.id);
    onClose();
  };

  return (
    <Modal
      title={
        isNew ? (
          'New skill'
        ) : (
          <span className="flex items-center gap-2">
            <span className="font-mono">/{skill!.name}</span>
            {readOnly && (
              <span className="rounded-full bg-border px-1.5 py-px text-2xs font-normal text-muted">
                {skill!.plugin} plugin — read-only
              </span>
            )}
          </span>
        )
      }
      width={640}
      onClose={onClose}
      onCmdEnter={() => void save()}
      footer={
        readOnly ? undefined : (
          <>
            {!isNew && (
              <button
                className={clsx('btn mr-auto h-8 px-3 text-xs', confirmDelete ? 'border-err text-err' : 'text-muted')}
                onClick={() => void remove()}
              >
                {confirmDelete ? 'Really delete?' : 'Delete'}
              </button>
            )}
            {isNew && (
              <Segmented<SkillLocation>
                value={location}
                options={[
                  { value: 'user', label: 'Personal — all projects' },
                  { value: 'project', label: 'Project — this repo' },
                ]}
                onChange={setLocation}
              />
            )}
            <button className="btn btn-accent h-8 px-3" disabled={saving || markdown === null} onClick={() => void save()}>
              {saving ? <Spinner className="!text-white" /> : 'Save skill'}
            </button>
          </>
        )
      }
    >
      {markdown === null ? (
        <div className="flex justify-center py-10">
          <Spinner />
        </div>
      ) : (
        <>
          <textarea
            autoFocus={!readOnly}
            className="h-72 w-full resize-y rounded-ctl border bg-raised px-3 py-2.5 font-mono text-xs leading-relaxed outline-none focus:border-accent"
            value={markdown}
            readOnly={readOnly}
            spellCheck={false}
            onChange={(e) => setMarkdown(e.target.value)}
          />
          {!readOnly && (
            <div className="mt-2 text-2xs text-faint">
              The frontmatter <span className="font-mono">name:</span> becomes the /command;{' '}
              <span className="font-mono">description:</span> is what the / menu shows. Saved{' '}
              {location === 'user' ? 'to your home config — available in every workspace' : 'into the worktree — commits with this branch'}
              , usable immediately.
            </div>
          )}
        </>
      )}
    </Modal>
  );
}
