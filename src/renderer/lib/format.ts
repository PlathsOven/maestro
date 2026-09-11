// Moved to the shared UI package (web-desktop-parity spec §2.5) so the renderer
// and Maestro Web render markdown / times / diffs identically. This re-export
// keeps existing renderer imports (`../lib/format`) working.
export * from '../../shared/ui/format';
