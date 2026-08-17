/**
 * Player display settings for THE MARS TRAIL.
 *
 * These only affect presentation — never the simulation — so they are safe to
 * persist and to change mid-run. Stored in localStorage so a chosen look
 * survives a reload.
 */

const STORAGE_KEY = 'mars-trail:display-settings';

export interface DisplaySettings {
  /** Internal render height in pixels. Lower is chunkier. */
  internalHeight: number;
  /** Composite exposure multiplier. */
  exposure: number;
  /** Monochrome CRT filter. */
  phosphor: boolean;
}

export interface SettingOption<T> {
  label: string;
  value: T;
  detail: string;
}

/**
 * Pixelation presets. 270 is the authored look and stays the default: it is
 * the resolution the palette clamp, dither grid, and 2px scanlines were tuned
 * against. Higher settings keep the same treatment but resolve more detail in
 * the generated models.
 */
export const PIXELATION_OPTIONS: Array<SettingOption<number>> = [
  { label: 'Chunky', value: 180, detail: 'Coarsest. Big, obvious pixels.' },
  { label: 'Classic', value: 270, detail: 'The authored look. Default.' },
  { label: 'Sharp', value: 405, detail: 'Finer grain, models read more clearly.' },
  { label: 'HD', value: 540, detail: 'Barely pixelated. Closest to raw 3D.' },
];

export const BRIGHTNESS_OPTIONS: Array<SettingOption<number>> = [
  { label: 'Dim', value: 1.25, detail: 'Darker, heavier shadows.' },
  { label: 'Normal', value: 1.6, detail: 'Default.' },
  { label: 'Bright', value: 1.95, detail: 'Lifts the deep-space legs.' },
  { label: 'Brightest', value: 2.35, detail: 'Maximum readability.' },
];

export const DEFAULT_SETTINGS: DisplaySettings = {
  internalHeight: 270,
  exposure: 1.6,
  phosphor: false,
};

function isValid(settings: Partial<DisplaySettings>): boolean {
  return (
    PIXELATION_OPTIONS.some((o) => o.value === settings.internalHeight) &&
    typeof settings.exposure === 'number' &&
    settings.exposure >= 0.2 &&
    settings.exposure <= 4
  );
}

export function loadSettings(): DisplaySettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(raw) as Partial<DisplaySettings>;
    // A stored value from an older build may name a preset that no longer
    // exists; fall back rather than rendering at an untested resolution.
    if (!isValid(parsed)) return { ...DEFAULT_SETTINGS };
    return {
      internalHeight: parsed.internalHeight ?? DEFAULT_SETTINGS.internalHeight,
      exposure: parsed.exposure ?? DEFAULT_SETTINGS.exposure,
      phosphor: Boolean(parsed.phosphor),
    };
  } catch {
    // Private browsing and disabled storage both throw here; the defaults are
    // a perfectly good answer.
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(settings: DisplaySettings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Not being able to persist is not worth interrupting play over.
  }
}
