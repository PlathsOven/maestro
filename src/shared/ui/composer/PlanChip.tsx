'use client';
import clsx from 'clsx';
import { NotebookPen } from 'lucide-react';
import { HARNESS_PLAN_MODE, type HarnessId } from '../models';

/**
 * Plan-mode toggle chip (web-desktop-parity spec §7.3). Renders nothing for a
 * harness without a plan-style mode (HARNESS_PLAN_MODE).
 */
export function PlanChip({ harness, on, onToggle }: { harness: HarnessId; on: boolean; onToggle: () => void }) {
  const tip = HARNESS_PLAN_MODE[harness];
  if (!tip) return null;
  return (
    <button
      className={clsx('btn btn-ghost h-6 gap-1 px-1.5 text-xs', on && 'bg-accent-soft text-accent')}
      title="Plan mode (⇧Tab)"
      onClick={onToggle}
    >
      <NotebookPen size={13} /> Plan
    </button>
  );
}
