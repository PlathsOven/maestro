'use client';
import { useId, useState } from 'react';
import clsx from 'clsx';
import { CornerDownLeft, ListChecks } from 'lucide-react';
import type { AskAnswer, AskQuestion } from '../types';

/** Per-question local selection state (option toggles + the free-form "Other"). */
interface QState {
  options: boolean[];
  other: boolean;
  otherText: string;
}

/**
 * The inline picker an agent's `maestro-ask` call renders in its live turn. Radio
 * rows for single-select, checkboxes for multi-select, plus an always-present
 * free-form "Other" — mirroring Conductor's AskUserQuestion. Moved to the shared
 * UI package (web-desktop-parity spec §2.5, §8): prop-driven so the desktop
 * resolves via IPC and the web via a desktop-executed job.
 */
export default function AskCard({
  questions,
  onAnswer,
  onSkip,
}: {
  questions: AskQuestion[];
  onAnswer: (answers: AskAnswer[]) => void;
  onSkip: () => void;
}) {
  const uid = useId();
  const [state, setState] = useState<QState[]>(() =>
    questions.map((q) => ({ options: q.options.map(() => false), other: false, otherText: '' }))
  );

  const selectedFor = (qi: number): string[] => {
    const st = state[qi];
    const out: string[] = [];
    questions[qi].options.forEach((opt, i) => {
      if (st.options[i]) out.push(opt);
    });
    if (st.other && st.otherText.trim()) out.push(st.otherText.trim());
    return out;
  };

  // Every question needs at least one concrete pick (an option, or non-empty Other).
  const complete = questions.every((_, qi) => selectedFor(qi).length > 0);

  const pickOption = (qi: number, i: number) => {
    setState((prev) =>
      prev.map((st, idx) => {
        if (idx !== qi) return st;
        if (questions[qi].multiSelect) {
          const options = st.options.slice();
          options[i] = !options[i];
          return { ...st, options };
        }
        // Single-select: choosing an option is exclusive and clears "Other".
        return { ...st, options: st.options.map((_, k) => k === i), other: false };
      })
    );
  };

  const pickOther = (qi: number) => {
    setState((prev) =>
      prev.map((st, idx) => {
        if (idx !== qi) return st;
        if (questions[qi].multiSelect) return { ...st, other: !st.other };
        return { ...st, options: st.options.map(() => false), other: true };
      })
    );
  };

  const setOtherText = (qi: number, text: string) => {
    setState((prev) => prev.map((st, idx) => (idx === qi ? { ...st, other: true, otherText: text } : st)));
  };

  const submit = () => {
    if (!complete) return;
    const answers: AskAnswer[] = questions.map((q, qi) => ({ question: q.question, selected: selectedFor(qi) }));
    onAnswer(answers);
  };

  return (
    <div className="rounded-card border border-accent bg-surface">
      <div className="flex items-center gap-2 border-b px-3.5 py-2 text-2xs font-semibold uppercase tracking-wide text-muted">
        <ListChecks size={13} className="text-accent" />
        {questions.length > 1 ? `The agent is asking ${questions.length} questions` : 'The agent is asking'}
      </div>

      <div className="space-y-4 px-3.5 py-3">
        {questions.map((q, qi) => {
          const st = state[qi];
          const name = `ask-${uid}-${qi}`;
          return (
            <div key={qi} className="space-y-2">
              <div className="text-body font-medium text-fg">{q.question}</div>
              {q.multiSelect && <div className="text-2xs text-faint">Select all that apply.</div>}
              <div className="space-y-1.5">
                {q.options.map((opt, i) => (
                  <OptionRow
                    key={i}
                    multi={!!q.multiSelect}
                    name={name}
                    label={opt}
                    checked={st.options[i]}
                    onSelect={() => pickOption(qi, i)}
                  />
                ))}
                <OptionRow
                  multi={!!q.multiSelect}
                  name={name}
                  label="Other…"
                  checked={st.other}
                  onSelect={() => pickOther(qi)}
                />
                {st.other && (
                  <input
                    className="input ml-6 w-[calc(100%-1.5rem)]"
                    autoFocus
                    value={st.otherText}
                    placeholder="Type your answer…"
                    onChange={(e) => setOtherText(qi, e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit();
                    }}
                  />
                )}
              </div>
            </div>
          );
        })}
      </div>

      <div className="flex items-center justify-between gap-3 border-t px-3.5 py-2.5">
        <button className="btn btn-ghost text-muted" onClick={onSkip} title="Let the agent proceed without answering">
          Skip
        </button>
        <button className="btn btn-accent" disabled={!complete} onClick={submit}>
          <CornerDownLeft size={13} /> Send answer{questions.length > 1 ? 's' : ''}
        </button>
      </div>
    </div>
  );
}

function OptionRow({
  multi,
  name,
  label,
  checked,
  onSelect,
}: {
  multi: boolean;
  name: string;
  label: string;
  checked: boolean;
  onSelect: () => void;
}) {
  return (
    <label
      className={clsx(
        'flex cursor-pointer items-center gap-2.5 rounded-ctl border px-3 py-2 text-body transition-colors tap',
        checked ? 'border-accent bg-accent-soft text-fg' : 'border-border bg-raised text-fg hover:border-faint'
      )}
    >
      <input
        type={multi ? 'checkbox' : 'radio'}
        name={name}
        className="accent-accent"
        checked={checked}
        onChange={onSelect}
      />
      <span>{label}</span>
    </label>
  );
}
