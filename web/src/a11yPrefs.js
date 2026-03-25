export const A11Y_PREFS_STORAGE_KEY = 'storibloom_a11y_prefs_v2';
export const A11Y_PREFS_LEGACY_KEY = 'storibloom_a11y_prefs_v1';
export const A11Y_PREFS_EVENT = 'storibloom:a11y_prefs_changed';

const DEFAULT_PREFS = Object.freeze({
  highContrast: false,
  dyslexicFont: false,
  reduceMotion: true,
  readAloud: false,
  captionedPrompts: true,
});

function systemReduceMotionPreferred() {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return !!window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export function defaultA11yPrefs() {
  return {
    ...DEFAULT_PREFS,
    reduceMotion: DEFAULT_PREFS.reduceMotion || systemReduceMotionPreferred(),
  };
}

function normalizeA11yPrefs(input = {}) {
  const defaults = defaultA11yPrefs();
  return {
    highContrast: !!input.highContrast,
    dyslexicFont: !!input.dyslexicFont,
    reduceMotion:
      input.reduceMotion === undefined ? !!defaults.reduceMotion : !!input.reduceMotion,
    readAloud: !!input.readAloud,
    captionedPrompts:
      input.captionedPrompts === undefined
        ? !!defaults.captionedPrompts
        : !!input.captionedPrompts,
  };
}

function readStorage(key) {
  if (typeof localStorage === 'undefined') return null;
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function loadA11yPrefs() {
  const current = readStorage(A11Y_PREFS_STORAGE_KEY);
  if (current && typeof current === 'object') {
    return normalizeA11yPrefs(current);
  }
  const legacy = readStorage(A11Y_PREFS_LEGACY_KEY);
  if (legacy && typeof legacy === 'object') {
    return normalizeA11yPrefs(legacy);
  }
  return defaultA11yPrefs();
}

export function saveA11yPrefs(input = {}) {
  const next = normalizeA11yPrefs(input);
  if (typeof localStorage !== 'undefined') {
    try {
      localStorage.setItem(A11Y_PREFS_STORAGE_KEY, JSON.stringify(next));
    } catch {}
  }
  if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
    window.dispatchEvent(new CustomEvent(A11Y_PREFS_EVENT, { detail: next }));
  }
  return next;
}

export function subscribeA11yPrefs(listener) {
  if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') {
    return () => {};
  }
  const onChange = (event) => {
    listener?.(normalizeA11yPrefs(event?.detail || {}));
  };
  window.addEventListener(A11Y_PREFS_EVENT, onChange);
  return () => window.removeEventListener(A11Y_PREFS_EVENT, onChange);
}
