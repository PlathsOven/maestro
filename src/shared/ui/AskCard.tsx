'use client';
import { useEffect, useId, useRef, useState } from 'react';
import clsx from 'clsx';
import { ChevronLeft, CornerDownLeft, ListChecks, Paperclip, X } from 'lucide-react';
import type { AskAnswer, AskQuestion } from '../types';

/** Per-question local selection state (option toggles + the free-form "Other"). */
interface QState {
  options: boolean[];
  other: boolean;
  otherText: string;
  /** Paths of files attached to this question's answer (hosts with `onAttach`). */
  files: string[];
}

/** Keys aimed at something else: a text field being typed in (the composer
 *  too), or a focused button that ↵ should press. The card's own radios and
 *  checkboxes don't count — they take focus when clicked. */
const elsewhere = (t: EventTarget | null) =>
  t instanceof HTMLElement &&
  (t.isContentEditable ||
    /^(TEXTAREA|SELECT|BUTTON)$/.test(t.tagName) ||
    (t instanceof HTMLInputElement && t.type !== 'radio' && t.type !== 'checkbox'));

/**
 * The inline picker an agent's `maestro-ask` call renders in its live turn — one
 * question at a time. Radio rows for single-select, checkboxes for multi-select,
 * plus an always-present free-form "Other" — mirroring Conductor's
 * AskUserQuestion. Keys 1–9 pick an option and ↵ moves on (both only while no
 * text field has focus); a single-select pick advances by itself. Moved to the
 * shared UI package (web-desktop-parity spec §2.5, §8): prop-driven so the
 * desktop resolves via IPC and the web via a desktop-executed job. `onAttach`
 * (desktop only) lets an answer carry files: pasted or picked into "Other", they
 * reach the agent as paths.
 */
export default function AskCard({
  questions,
  onAnswer,
  onSkip,
  onAttach,
}: {
  questions: AskQuestion[];
  onAnswer: (answers: AskAnswer[]) => void;
  onSkip: () => void;
  onAttach?: (files: File[]) => Promise<string[]>;
}) {
  const uid = useId();
  const [state, setState] = useState<QState[]>(() =>
    questions.map((q) => ({ options: q.options.map(() => false), other: false, otherText: '', files: [] }))
  );
  const [step, setStep] = useState(0);
  const advance = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(advance.current), []);

  const selectedFor = (qi: number): string[] => {
    const st = state[qi];
    const out: string[] = [];
    questions[qi].options.forEach((opt, i) => {
      if (st.options[i]) out.push(opt);
    });
    if (st.other && st.otherText.trim()) out.push(st.otherText.trim());
    for (const f of st.files) out.push(`Attached file: ${f}`);
    return out;
  };

  // Every question needs at least one concrete pick (an option, Other text, or a file).
  const answered = (qi: number) => selectedFor(qi).length > 0;
  const complete = questions.every((_, qi) => answered(qi));
  const last = step === questions.length - 1;
  const q = questions[step];
  const st = state[step];

  const patch = (qi: number, fn: (st: QState) => QState) =>
    setState((prev) => prev.map((s, idx) => (idx === qi ? fn(s) : s)));

  const pickOption = (qi: number, i: number) => {
    clearTimeout(advance.current);
    if (questions[qi].multiSelect) {
      patch(qi, (s) => ({ ...s, options: s.options.map((on, k) => (k === i ? !on : on)) }));
      return;
    }
    // Single-select: choosing an option is exclusive, clears "Other", and moves on.
    patch(qi, (s) => ({ ...s, options: s.options.map((_, k) => k === i), other: false }));
    if (qi < questions.length - 1) advance.current = setTimeout(() => setStep(qi + 1), 200);
  };

  const pickOther = (qi: number) => {
    clearTimeout(advance.current);
    patch(qi, (s) =>
      questions[qi].multiSelect ? { ...s, other: !s.other } : { ...s, options: s.options.map(() => false), other: true }
    );
  };

  const attach = async (qi: number, files: File[]) => {
    if (!onAttach || !files.length) return;
    const paths = await onAttach(files);
    patch(qi, (s) => ({ ...s, files: [...s.files, ...paths] }));
  };

  const submit = () => {
    if (!complete) return;
    onAnswer(questions.map((q, qi) => ({ question: q.question, selected: selectedFor(qi) })));
  };
  // ↵ from a text field or a key: the next question, or send on the last one.
  const next = () => (last ? submit() : answered(step) && setStep(step + 1));

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (elsewhere(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === 'Enter') {
        e.preventDefault();
        next();
        return;
      }
      const n = Number(e.key);
      if (!Number.isInteger(n) || n < 1) return;
      if (n <= q.options.length) pickOption(step, n - 1);
      else if (n === q.options.length + 1) pickOther(step);
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const pickFiles = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.onchange = () => void attach(step, Array.from(input.files ?? []));
    input.click();
  };

  return (
    <div className="rounded-card border bg-raised shadow-[var(--shadow)]">
      <div className="flex items-center gap-2 px-4 pb-1 pt-3.5 text-xs font-medium text-muted">
        <ListChecks size={13} className="text-accent" />
        The agent is asking
        {questions.length > 1 && (
          <span className="ml-auto flex items-center gap-1" aria-label={`Question ${step + 1} of ${questions.length}`}>
            {questions.map((_, i) => (
              <button
                key={i}
                title={`Question ${i + 1}`}
                onClick={() => setStep(i)}
                className={clsx(
                  'h-1.5 rounded-full transition-all',
                  i === step ? 'w-4 bg-accent' : answered(i) ? 'w-1.5 bg-muted' : 'w-1.5 bg-border'
                )}
              />
            ))}
          </span>
        )}
      </div>

      <div key={step} data-motion="row" className="space-y-2 px-4 pb-3 pt-2">
        <div className="text-body font-medium text-fg">{q.question}</div>
        {q.multiSelect && <div className="text-2xs text-faint">Select all that apply.</div>}
        <div className="space-y-1">
          {q.options.map((opt, i) => (
            <OptionRow
              key={i}
              multi={!!q.multiSelect}
              name={`ask-${uid}-${step}`}
              label={opt}
              hint={i < 9 ? String(i + 1) : undefined}
              checked={st.options[i]}
              onSelect={() => pickOption(step, i)}
            />
          ))}
          <OptionRow
            multi={!!q.multiSelect}
            name={`ask-${uid}-${step}`}
            label="Other…"
            hint={q.options.length < 9 ? String(q.options.length + 1) : undefined}
            checked={st.other}
            onSelect={() => pickOther(step)}
          />
          {st.other && (
            <div className="ml-6 flex items-center gap-1.5">
              <input
                className="input min-w-0 flex-1"
                autoFocus
                value={st.otherText}
                placeholder={onAttach ? 'Type your answer, or paste a file…' : 'Type your answer…'}
                onChange={(e) => patch(step, (s) => ({ ...s, other: true, otherText: e.target.value }))}
                onPaste={(e) => {
                  const files = Array.from(e.clipboardData.files);
                  if (!onAttach || !files.length) return;
                  e.preventDefault();
                  void attach(step, files);
                }}
                onKeyDown={(e) => {
                  // Enter moves on (skip while an IME composition is being confirmed).
                  if (e.key !== 'Enter' || e.nativeEvent.isComposing) return;
                  e.preventDefault();
                  next();
                }}
              />
              {onAttach && (
                <button className="btn btn-ghost h-8 w-8 !px-0 text-muted" title="Attach files" onClick={pickFiles}>
                  <Paperclip size={13} />
                </button>
              )}
            </div>
          )}
          {st.files.length > 0 && (
            <div className="ml-6 flex flex-wrap gap-1.5 pt-1">
              {st.files.map((f, i) => (
                <span key={i} className="inline-flex max-w-full items-center gap-1 rounded-full bg-surface px-2 py-0.5 text-2xs text-muted">
                  <Paperclip size={10} className="shrink-0" />
                  <span className="truncate">{f.split('/').pop()}</span>
                  <button
                    className="shrink-0 text-faint hover:text-fg"
                    title="Remove"
                    onClick={() => patch(step, (s) => ({ ...s, files: s.files.filter((_, k) => k !== i) }))}
                  >
                    <X size={10} />
                  </button>
                </span>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="flex items-center gap-2 px-4 pb-3.5 pt-1">
        <button className="btn btn-ghost text-muted" onClick={onSkip} title="Let the agent proceed without answering">
          Skip
        </button>
        <div className="flex-1" />
        {step > 0 && (
          <button className="btn btn-ghost text-muted" onClick={() => setStep(step - 1)}>
            <ChevronLeft size={13} /> Back
          </button>
        )}
        {last ? (
          <button className="btn btn-accent" disabled={!complete} onClick={submit}>
            <CornerDownLeft size={13} /> Send answer{questions.length > 1 ? 's' : ''}
          </button>
        ) : (
          <button className="btn btn-accent" disabled={!answered(step)} onClick={next}>
            Next <CornerDownLeft size={13} />
          </button>
        )}
      </div>
    </div>
  );
}

function OptionRow({
  multi,
  name,
  label,
  hint,
  checked,
  onSelect,
}: {
  multi: boolean;
  name: string;
  label: string;
  /** the number key that picks this row */
  hint?: string;
  checked: boolean;
  onSelect: () => void;
}) {
  return (
    <label
      className={clsx(
        'flex cursor-pointer items-center gap-2.5 rounded-ctl px-3 py-2 text-body text-fg transition-colors tap',
        checked ? 'bg-accent-soft ring-1 ring-inset ring-faint' : 'ring-1 ring-inset ring-border hover:bg-accent-soft/60'
      )}
    >
      <input
        type={multi ? 'checkbox' : 'radio'}
        name={name}
        className="accent-accent"
        checked={checked}
        onChange={onSelect}
      />
      <span className="min-w-0 flex-1">{label}</span>
      {hint && <kbd className="hidden shrink-0 font-mono text-2xs text-faint sm:inline">{hint}</kbd>}
    </label>
  );
}
