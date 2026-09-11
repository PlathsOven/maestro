// Decouples "evict a workspace's editor buffers" from the monaco-owning buffer
// cache, so the store can trigger eviction (on archive / delete / removal)
// without importing monaco into the main bundle. The lazily-loaded editor chunk
// registers the real disposer once it mounts; before that, eviction is a no-op
// (there are no buffers to free).
type Evictor = (wsId: string) => void;

let evictor: Evictor | null = null;

export function registerBufferEvictor(fn: Evictor): void {
  evictor = fn;
}

export function evictWorkspaceBuffers(wsId: string): void {
  evictor?.(wsId);
}
