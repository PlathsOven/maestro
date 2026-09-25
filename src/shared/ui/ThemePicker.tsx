import clsx from 'clsx';
import { Check, FlaskConical } from 'lucide-react';
import { COLOR_THEMES, type ColorThemeId } from '../themes';

/**
 * The theme-family picker (Settings → Appearance, desktop and web). Each card
 * previews the family's light and dark variants side by side; the previews wear
 * the theme themselves — `data-theme` + `.dark` on the preview element pick up
 * the palette from themes.css — so there are no swatch values to keep in sync.
 * Experimental families (type, shape and texture changes) get their own section.
 */
export function ThemePicker({
  value,
  onChange,
  className,
}: {
  value: ColorThemeId;
  onChange: (id: ColorThemeId) => void;
  className?: string;
}) {
  const grid = clsx('grid gap-2.5', className ?? 'grid-cols-2 sm:grid-cols-4');
  const card = (t: (typeof COLOR_THEMES)[number]) => {
    const on = t.id === value;
    return (
      <button
        key={t.id}
        type="button"
        role="radio"
        aria-checked={on}
        title={t.blurb}
        onClick={() => onChange(t.id)}
        className={clsx('group rounded-card p-1.5 text-left transition-colors', on ? 'bg-accent-tint' : 'hover:bg-accent-soft')}
        style={{ boxShadow: on ? '0 0 0 1.5px var(--accent)' : '0 0 0 1px var(--border)' }}
      >
        <div className="flex h-[58px] overflow-hidden rounded-[9px]">
          <ThemePreview id={t.id} dark={false} />
          <ThemePreview id={t.id} dark />
        </div>
        <div className="flex items-center gap-1 px-1 pb-0.5 pt-1.5">
          <span className="min-w-0 flex-1 truncate text-xs font-medium text-fg">{t.label}</span>
          {on && <Check size={12} className="shrink-0 text-accent" />}
        </div>
      </button>
    );
  };
  const isExperimental = (t: (typeof COLOR_THEMES)[number]) => 'experimental' in t && t.experimental;
  return (
    <div role="radiogroup" aria-label="Theme" className="space-y-3">
      <div className={grid}>{COLOR_THEMES.filter((t) => !isExperimental(t)).map(card)}</div>
      <div className="flex items-center gap-1.5 px-0.5 pt-1 text-2xs font-medium text-muted">
        <FlaskConical size={12} className="shrink-0" />
        Experimental
        <span className="font-normal text-faint">— these change more than colour</span>
      </div>
      <div className={grid}>{COLOR_THEMES.filter(isExperimental).map(card)}</div>
    </div>
  );
}

/** A thumbnail of the app in one variant: chrome, a sidebar with a live dot,
 *  and the stage with a user bubble, a reply and an accent pill. */
function ThemePreview({ id, dark }: { id: ColorThemeId; dark: boolean }) {
  return (
    <div
      data-theme={id}
      className={clsx('flex flex-1 gap-1 p-1', dark && 'dark')}
      style={{ background: 'var(--bg)' }}
      aria-hidden
    >
      <div className="flex w-[26%] flex-col gap-1 pt-1">
        <span className="flex items-center gap-0.5">
          <span className="h-1 w-1 shrink-0 rounded-full" style={{ background: 'var(--st-running)' }} />
          <span className="h-[3px] flex-1 rounded-full" style={{ background: 'var(--muted)' }} />
        </span>
        <span className="h-[3px] w-[80%] rounded-full" style={{ background: 'var(--faint)' }} />
        <span className="h-[3px] w-[65%] rounded-full" style={{ background: 'var(--faint)' }} />
      </div>
      <div
        className="flex flex-1 flex-col gap-[3px] rounded-[5px] p-1"
        style={{ background: 'var(--canvas)', boxShadow: '0 0 0 0.5px var(--border)' }}
      >
        <span className="ml-auto h-[7px] w-[55%] rounded-[3px]" style={{ background: 'var(--user-msg)' }} />
        <span className="h-[3px] w-[85%] rounded-full" style={{ background: 'var(--text)' }} />
        <span className="h-[3px] w-[60%] rounded-full" style={{ background: 'var(--muted)' }} />
        <span className="mt-auto flex items-center gap-[3px]">
          <span className="h-[6px] w-[34%] rounded-full" style={{ background: 'var(--accent)' }} />
          <span className="h-[4px] w-[4px] rounded-full" style={{ background: 'var(--ok)' }} />
          <span className="h-[4px] w-[4px] rounded-full" style={{ background: 'var(--warn)' }} />
          <span className="h-[4px] w-[4px] rounded-full" style={{ background: 'var(--err)' }} />
        </span>
      </div>
    </div>
  );
}
