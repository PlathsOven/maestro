import { useState } from 'react';
import clsx from 'clsx';
import { CheckCircle2, Circle, Plus, Trash2 } from 'lucide-react';
import { tryInvoke } from '../lib/api';
import { EMPTY_ARR, useApp } from '../store/app';
import type { Workspace } from '../../shared/types';

export function TodoSection({ workspace, compact }: { workspace: Workspace; compact?: boolean }) {
  const todos = useApp((s) => s.todos[workspace.id]) ?? EMPTY_ARR;
  const [text, setText] = useState('');

  const add = async () => {
    if (!text.trim()) return;
    await tryInvoke('todo:add', { workspaceId: workspace.id, text: text.trim() });
    setText('');
    void useApp.getState().refreshTodos(workspace.id);
  };

  return (
    <section className={compact ? '' : 'card p-3.5'}>
      <div className="mb-3 text-xs font-medium text-muted">
        Todos{' '}
        <span className="font-normal text-faint">
          ({todos.filter((t) => t.done).length}/{todos.length})
        </span>
      </div>
      <div className="space-y-1">
        {todos.map((t) => (
          <div key={t.id} data-motion="row" className="group flex items-center gap-2 text-xs">
            <button
              onClick={async () => {
                await tryInvoke('todo:toggle', { todoId: t.id, done: !t.done });
                void useApp.getState().refreshTodos(workspace.id);
              }}
            >
              {t.done ? <CheckCircle2 size={13} className="text-ok" /> : <Circle size={13} className="text-faint hover:text-muted" />}
            </button>
            <span className={clsx('min-w-0 flex-1', t.done && 'text-faint line-through')}>{t.text}</span>
            <button
              className="hidden text-faint hover:text-err group-hover:block"
              onClick={async () => {
                await tryInvoke('todo:delete', { todoId: t.id });
                void useApp.getState().refreshTodos(workspace.id);
              }}
            >
              <Trash2 size={11} />
            </button>
          </div>
        ))}
      </div>
      <div className="mt-2 flex items-center gap-1.5">
        <input
          className="input h-7 flex-1 py-0 text-xs"
          placeholder="Add a todo before merge…"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void add()}
        />
        <button className="btn h-7 w-7 !px-0" onClick={() => void add()} disabled={!text.trim()}>
          <Plus size={12} />
        </button>
      </div>
    </section>
  );
}
