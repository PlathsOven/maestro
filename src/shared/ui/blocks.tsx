'use client';
import { useMemo, useState } from 'react';
import clsx from 'clsx';
import {
  Bot,
  Brain,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  FileText,
  Globe,
  Image as ImageIcon,
  ListChecks,
  MessageSquare,
  Paperclip,
  Pencil,
  Search,
  Terminal as TerminalIcon,
  Wrench,
  XCircle,
  type LucideIcon,
} from 'lucide-react';
import type { AgentBlock, Attachment } from '../types';
import { Markdown } from './Markdown';
import { EditDiff, buildEditDiff, parseEditTool } from './EditDiff';
import { Spinner } from './primitives';

/**
 * The agent-turn block renderer, moved to the shared UI package (web-desktop-parity
 * spec §2.5, §6.2) so the renderer and Maestro Web render transcripts identically:
 * markdown text, per-tool icon rows, consecutive-tool grouping, the finished-turn
 * activity fold, thinking folds, resolved-ask records, and edit diffs.
 */

export function BlockView({ b, running }: { b: AgentBlock; running?: boolean }) {
  if (b.type === 'text') return <Markdown text={b.text} className="px-1" />;
  if (b.type === 'thinking') return <ThinkingBlock text={b.text} />;
  if (b.type === 'ask') return <AskBlock block={b} />;
  return <ToolBlock block={b} running={running} />;
}

/**
 * A resolved `maestro-ask` prompt as it reads back in the trace: the question(s)
 * the agent posed with the user's chosen answer marked on each. Read-only — the
 * live, interactive picker is AskCard; this is the record it leaves behind. A
 * dismissed prompt (null answers) renders the questions with a "skipped" note.
 */
function AskBlock({ block }: { block: Extract<AgentBlock, { type: 'ask' }> }) {
  const { questions, answers } = block;
  const answerFor = (qi: number): string[] =>
    answers?.find((a) => a.question === questions[qi].question)?.selected ?? answers?.[qi]?.selected ?? [];
  return (
    <div className="mx-1 rounded-ctl border bg-surface/60 text-xs">
      <div className="flex items-center gap-2 border-b px-2.5 py-1.5 text-2xs font-semibold uppercase tracking-wide text-muted">
        <ListChecks size={12} className="shrink-0 text-accent" />
        {questions.length > 1 ? `Asked the user ${questions.length} questions` : 'Asked the user'}
        {answers === null && <span className="font-normal normal-case text-faint">· skipped</span>}
      </div>
      <div className="space-y-2.5 px-2.5 py-2">
        {questions.map((q, qi) => {
          const picked = answerFor(qi);
          return (
            <div key={qi} className="space-y-1">
              <div className="text-body font-medium text-fg">{q.question}</div>
              <div className="flex flex-wrap gap-1.5">
                {picked.length > 0 ? (
                  picked.map((p, i) => (
                    <span
                      key={i}
                      className="inline-flex items-center gap-1 rounded-ctl border border-accent bg-accent-soft px-2 py-0.5 text-2xs text-fg"
                    >
                      <Check size={11} className="shrink-0 text-accent" />
                      {p}
                    </span>
                  ))
                ) : (
                  <span className="text-2xs italic text-faint">No answer</span>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Where a turn's final answer starts: walk back over the trailing run of text
 * blocks. Everything before it is the working — narration, thinking, tool calls.
 */
export function answerStart(blocks: AgentBlock[]): number {
  let i = blocks.length;
  while (i > 0 && blocks[i - 1].type === 'text') i--;
  return i;
}

/**
 * Collapse a finished turn down to its final response: the trailing run of text
 * blocks (the answer) renders inline, and everything before it — preamble,
 * narration, thinking, and every tool call, however they interleave — folds into
 * a single activity chip. Keeps the working out of the way so the latest turn
 * reads as its conclusion, with one click to expand the full trace. Ask blocks
 * stay inline: a question the user answered is part of the record.
 */
export function foldBlocks(blocks: AgentBlock[]): (AgentBlock | AgentBlock[])[] {
  const answer = answerStart(blocks);
  const out: (AgentBlock | AgentBlock[])[] = [];
  let run: AgentBlock[] = [];
  const flush = () => {
    if (run.length) out.push(run);
    run = [];
  };
  for (const b of blocks.slice(0, answer)) {
    if (b.type === 'ask') {
      flush();
      out.push(b);
    } else {
      run.push(b);
    }
  }
  flush();
  out.push(...blocks.slice(answer));
  return out;
}

type ToolCall = Extract<AgentBlock, { type: 'tool' }>;

/**
 * Collapse consecutive tool calls that share a name into one group, so a live
 * turn reads as "Read ×5" instead of five identical rows. Text and thinking
 * blocks break a run and stay inline; a lone tool call stays a normal row.
 */
export function groupConsecutiveTools(blocks: AgentBlock[]): (AgentBlock | ToolCall[])[] {
  const rows: (AgentBlock | ToolCall[])[] = [];
  for (const b of blocks) {
    const last = rows[rows.length - 1];
    if (b.type === 'tool' && Array.isArray(last) && last[0].name === b.name) last.push(b);
    else rows.push(b.type === 'tool' ? [b] : b);
  }
  return rows;
}

export function BlockList({ blocks, streaming, folded }: { blocks: AgentBlock[]; streaming?: boolean; folded?: boolean }) {
  if (folded) {
    return (
      <div className="space-y-1.5">
        {foldBlocks(blocks).map((seg, i) =>
          Array.isArray(seg) ? <ActivityFold key={i} blocks={seg} /> : <BlockView key={i} b={seg} />
        )}
      </div>
    );
  }
  // Live turn: collapse consecutive same-tool calls into one group so a burst of
  // reads or writes reads as "Read ×5" instead of a wall of identical rows. Only
  // the very last tool — the one still executing — carries the running spinner.
  const rows = groupConsecutiveTools(blocks);
  return (
    <div className="space-y-1.5">
      {rows.map((row, i) => {
        if (!Array.isArray(row)) return <BlockView key={i} b={row} />;
        const running = streaming && i === rows.length - 1 && !row[row.length - 1].result;
        return row.length === 1 ? (
          <ToolBlock key={i} block={row[0]} running={running} />
        ) : (
          <ToolGroup key={i} tools={row} running={running} />
        );
      })}
    </div>
  );
}

export const TOOL_ICONS: [RegExp, LucideIcon][] = [
  [/bash|shell|terminal/i, TerminalIcon],
  [/read|write|edit|notebook/i, FileText],
  [/grep|glob|search|^ls$/i, Search],
  [/web|fetch|http/i, Globe],
  [/task|agent|todo/i, Bot],
];

function toolIcon(name: string): LucideIcon {
  for (const [re, icon] of TOOL_ICONS) if (re.test(name)) return icon;
  return Wrench;
}

/**
 * A finished turn's working folded into one chip — "N tool calls, M messages"
 * plus icons of the distinct tools used — so the turn reads as its final answer
 * first. Click to expand the full run. Failures stay visible on the chip.
 */
function ActivityFold({ blocks }: { blocks: AgentBlock[] }) {
  const [open, setOpen] = useState(false);
  const tools = blocks.filter((b) => b.type === 'tool');
  const msgs = blocks.filter((b) => b.type === 'text').length;
  const failed = tools.filter((t) => t.result && !t.result.ok).length;
  const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
  const parts: string[] = [];
  if (tools.length) parts.push(plural(tools.length, 'tool call'));
  if (msgs) parts.push(plural(msgs, 'message'));
  const label = parts.join(', ') || plural(blocks.length, 'step');
  const icons = [...new Set(tools.map((t) => toolIcon(t.name)))].slice(0, 4);
  return (
    <div className="px-1">
      <button
        className="group/fold flex items-center gap-1.5 py-0.5 text-xs text-faint transition-colors hover:text-muted"
        onClick={() => setOpen(!open)}
      >
        {open ? <ChevronDown size={11} className="shrink-0" /> : <ChevronRight size={11} className="shrink-0" />}
        <span>{label}</span>
        {icons.map((Icon, i) => (
          <Icon key={i} size={11} className="shrink-0 opacity-70" />
        ))}
        {failed > 0 && <span className="text-err">· {plural(failed, 'failed call')}</span>}
      </button>
      {open && (
        <div className="mt-1 space-y-1.5 border-l-2 pl-2">
          {blocks.map((b, i) => (
            <BlockView key={i} b={b} />
          ))}
        </div>
      )}
    </div>
  );
}

function ThinkingBlock({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="px-1">
      <button className="flex items-center gap-1 text-2xs italic text-faint hover:text-muted" onClick={() => setOpen(!open)}>
        <Brain size={11} />
        Thinking
        {open ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
      </button>
      {open && <div className="mt-1 whitespace-pre-wrap border-l-2 pl-2.5 text-xs italic text-muted">{text}</div>}
    </div>
  );
}

export function toolSummary(input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>;
  const s = (v: unknown) => (typeof v === 'string' ? v : '');
  return (
    s(i.file_path) || s(i.path) || s(i.command) || s(i.pattern) || s(i.query) || s(i.url) || s(i.description) || ''
  );
}

function ToolBlock({ block, running }: { block: ToolCall; running?: boolean }) {
  // File-editing tools render as a diff, not raw JSON. Detected by input shape.
  const edit = useMemo(() => parseEditTool(block.name, block.input), [block.name, block.input]);
  const diff = useMemo(() => (edit ? buildEditDiff(edit) : null), [edit]);
  // All tool calls — edits included — start collapsed; click the header to expand
  // the diff/output. (The header already shows the file and its +/− counts.)
  const [open, setOpen] = useState(false);
  const summary = edit ? edit.file.split('/').pop() || edit.file : toolSummary(block.input);
  const failed = block.result && !block.result.ok;
  const Icon = edit
    ? FileText
    : block.name.toLowerCase().includes('bash') || block.name === 'shell'
      ? TerminalIcon
      : Wrench;
  return (
    <div className={clsx('mx-1 rounded-ctl border bg-surface/60 text-xs', failed && 'border-err/40')}>
      <button className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left" onClick={() => setOpen(!open)}>
        <Icon size={12} className="shrink-0 text-muted" />
        <span className="shrink-0 font-medium">{block.name}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-2xs text-muted">{summary}</span>
        {diff && (diff.adds > 0 || diff.dels > 0) && (
          <span className="shrink-0 font-mono text-2xs">
            {diff.adds > 0 && <span className="text-ok">+{diff.adds}</span>}
            {diff.adds > 0 && diff.dels > 0 && ' '}
            {diff.dels > 0 && <span className="text-err">−{diff.dels}</span>}
          </span>
        )}
        {running ? (
          <Spinner className="!h-3 !w-3" />
        ) : failed ? (
          <XCircle size={12} className="shrink-0 text-err" />
        ) : block.result ? (
          <CheckCircle2 size={12} className="shrink-0 text-ok" />
        ) : null}
        {open ? <ChevronDown size={11} className="shrink-0 text-faint" /> : <ChevronRight size={11} className="shrink-0 text-faint" />}
      </button>
      {open && (
        <div className="space-y-1.5 border-t px-2.5 py-2">
          {diff ? (
            <EditDiff diff={diff} />
          ) : (
            <pre className="max-h-48 overflow-auto whitespace-pre-wrap font-mono text-2xs text-muted">
              {JSON.stringify(block.input, null, 2)}
            </pre>
          )}
          {/* For edits the "file updated successfully" note is noise — show it only on failure. */}
          {block.result?.summary && (!edit || failed) && (
            <pre
              className={clsx(
                'max-h-48 overflow-auto whitespace-pre-wrap border-t pt-1.5 font-mono text-2xs',
                failed ? 'text-err' : 'text-muted'
              )}
            >
              {block.result.summary}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * A run of same-named tool calls (e.g. five Reads) collapsed into one row while
 * the turn streams. The header counts the calls and shows the latest target;
 * click to expand each call. Any failure surfaces on the header.
 */
function ToolGroup({ tools, running }: { tools: ToolCall[]; running?: boolean }) {
  const [open, setOpen] = useState(false);
  const name = tools[0].name;
  const last = tools[tools.length - 1];
  const failed = tools.filter((t) => t.result && !t.result.ok).length;
  const Icon = toolIcon(name);
  return (
    <div className={clsx('mx-1 rounded-ctl border bg-surface/60 text-xs', failed > 0 && 'border-err/40')}>
      <button className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left" onClick={() => setOpen(!open)}>
        <Icon size={12} className="shrink-0 text-muted" />
        <span className="shrink-0 font-medium">{name}</span>
        <span className="shrink-0 text-2xs text-faint">×{tools.length}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-2xs text-muted">{toolSummary(last.input)}</span>
        {failed > 0 && <span className="shrink-0 text-2xs text-err">{failed} failed</span>}
        {running ? (
          <Spinner className="!h-3 !w-3" />
        ) : failed > 0 ? (
          <XCircle size={12} className="shrink-0 text-err" />
        ) : (
          <CheckCircle2 size={12} className="shrink-0 text-ok" />
        )}
        {open ? <ChevronDown size={11} className="shrink-0 text-faint" /> : <ChevronRight size={11} className="shrink-0 text-faint" />}
      </button>
      {open && (
        <div className="space-y-1.5 border-t px-2 py-2">
          {tools.map((t, i) => (
            <ToolBlock key={t.id || i} block={t} running={running && i === tools.length - 1} />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * A chat attachment pill. Presentational: `onOpen` (when set) makes it a button
 * that previews the attachment (desktop wires an in-app preview; the web leaves
 * it unset until attachments land in phase 3). `onRemove` shows the × used by
 * the composer's pending-attachment list.
 */
export function AttachmentChip({
  a,
  onRemove,
  onOpen,
}: {
  a: Attachment;
  onRemove?: () => void;
  onOpen?: () => void;
}) {
  const icon =
    a.kind === 'image' ? (
      <ImageIcon size={10} />
    ) : a.kind === 'annotations' ? (
      <Pencil size={10} />
    ) : a.kind === 'comments' ? (
      <MessageSquare size={10} />
    ) : a.kind === 'file' ? (
      <Paperclip size={10} />
    ) : (
      <FileText size={10} />
    );
  return (
    <span className="inline-flex items-center gap-1 rounded-full border bg-raised px-2 py-0.5 text-2xs text-muted">
      {onOpen ? (
        <button
          type="button"
          className="inline-flex min-w-0 items-center gap-1 transition-colors hover:text-fg"
          title="Preview attachment"
          onClick={onOpen}
        >
          {icon}
          <span className="max-w-48 truncate">{a.label}</span>
        </button>
      ) : (
        <>
          {icon}
          <span className="max-w-48 truncate">{a.label}</span>
        </>
      )}
      {onRemove && (
        <button className="text-faint hover:text-err" onClick={onRemove}>
          ×
        </button>
      )}
    </span>
  );
}
