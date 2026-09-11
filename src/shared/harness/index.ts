/**
 * Shared, pure harness pipeline (spec mobile-web-app §6.4, G7). Everything the
 * relay ingest needs to turn journal bytes into stored turns — the same code the
 * desktop main process runs — and everything the web client needs to render the
 * resulting `AgentBlock[]`. No node builtins, no main-process imports (enforced
 * by `scripts/check-seams.mjs`).
 */
export * from './frames';
export * from './parse';
export * from './blocks';

// Re-export the block/event types so the web app imports harness rendering types
// from one place (spec §6.8: "the web app imports src/shared/harness/ types …
// and nothing else from the app").
export type { AgentBlock, AgentEvent, ContextUsage, HarnessId } from '../types';
