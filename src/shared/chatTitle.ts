// One title rule for every surface (§7). A chat's title lives in ChatMeta.title;
// when it's absent, every rail/sidebar/status/header derives the same display
// string from the first user message — never a synthetic "Chat N".

/** The provisional title a chat gets from its first message (chat.ts, app.ts, ChatPanel agree). */
export function provisionalTitle(text: string): string {
  return text.trim().replace(/\s+/g, ' ').slice(0, 40);
}

/** What every surface shows for a chat. Never a synthetic "Chat N". */
export function chatDisplayTitle(meta: { title?: string } | undefined, firstUserText?: string | null): string {
  return meta?.title || (firstUserText ? provisionalTitle(firstUserText) : '') || 'New chat';
}
