// Moved to the shared UI package (web-desktop-parity spec §2.5) so the renderer
// and Maestro Web derive status indicators from one implementation. This
// re-export keeps existing renderer imports (`../lib/status`) working.
export * from '../../shared/ui/status';
