import { invoke } from './api';

/** Copy via main's native clipboard: `navigator.clipboard.writeText` rejects
 *  ("Document is not focused") whenever another webContents — e.g. the preview
 *  view, even hidden — holds focus, so copy buttons silently did nothing. */
export const copyText = (text: string) => invoke('clipboard:writeText', { text });
