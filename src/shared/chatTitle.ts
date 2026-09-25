// One title rule for every surface (§7). A chat's title lives in ChatMeta.title;
// when it's absent, every rail/sidebar/status/header derives the same display
// string from the first user message — never a synthetic "Chat N".

/** The line `maestro-message` appends to another agent's message, naming the
 *  sender and the exact reply command (docs/specs/agent-messaging.md). */
export function agentMessageFooter(reply: string, project: string): string {
  return `[Sent by the agent in "${reply}" (${project}). Reply with: maestro-message send ${reply}]`;
}

const FOOTER_START = '[Sent by the agent in "';
const FOOTER_REPLY = '. Reply with: maestro-message send ';

/** A message's text without that footer: it must never end up in a title.
 *  A plain linear scan, not a regex — this runs on every title, synchronously,
 *  and pasted text can be megabytes of whitespace. The footer is the text's last
 *  line; its fields aren't parsed, so any project name strips cleanly. */
export function withoutAgentFooter(text: string): string {
  const end = text.trimEnd();
  if (!end.endsWith(']')) return text;
  const at = end.lastIndexOf(FOOTER_START);
  if (at < 0 || (at > 0 && end[at - 1] !== '\n')) return text;
  const footer = end.slice(at);
  if (footer.includes('\n') || !footer.includes(FOOTER_REPLY)) return text;
  return end.slice(0, at).trimEnd();
}

/** The provisional title a chat gets from its first message (chat.ts, app.ts, ChatPanel agree). */
export function provisionalTitle(text: string): string {
  return withoutAgentFooter(text).trim().replace(/\s+/g, ' ').slice(0, 40);
}

/** What every surface shows for a chat. Never a synthetic "Chat N". */
export function chatDisplayTitle(meta: { title?: string } | undefined, firstUserText?: string | null): string {
  return meta?.title || (firstUserText ? provisionalTitle(firstUserText) : '') || 'New chat';
}
