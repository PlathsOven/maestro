// The shared UI package (web-desktop-parity spec §2.3): one presentational layer
// imported by both the Electron renderer (src/renderer) and Maestro Web (web/).
// The web imports the @shared/ui alias; the desktop imports the individual files.

export * from './format';
export * from './status';
export * from './models';
export * from './host';
export * from './primitives';
export * from './Modal';
export * from './EditDiff';
export { Markdown, default as MarkdownDefault } from './Markdown';
export * from './blocks';
export * from './transcript';
export { default as AskCard } from './AskCard';
export * from './toasts';
export * from './diff';
export * from './panels/types';
export * from './panels/PrActions';
export * from './panels/ChangesView';
export * from './panels/ChecksView';
export * from './panels/StatusPanelView';
export * from './panels/RunView';
export * from './composer/ComposerFrame';
export * from './composer/ModelChip';
export * from './composer/EffortChip';
export * from './composer/PlanChip';
export * from './composer/QueuedCard';
export * from './composer/ContextRing';
