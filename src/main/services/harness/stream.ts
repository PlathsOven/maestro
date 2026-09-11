/**
 * The block accumulator now lives in `src/shared/harness/blocks.ts` so the relay
 * ingest builds `AgentBlock[]` with the exact same code the desktop runs (spec
 * mobile-web-app §6.4, G7). Re-exported here so the top-level agent runner
 * (harness/index) and the specialist runner (services/roles) keep their imports.
 */
export {
  applyBlockEvent,
  finalizeBlocks,
  newBlockStream,
  snapshotBlocks,
  summarizeBlocks,
  type BlockStream,
} from '../../../shared/harness/blocks';
