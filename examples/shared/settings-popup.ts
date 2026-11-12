/**
 * The gear popup the G5 pages share: quick choices first, connection fields,
 * an Advanced section, and an Apply button that shows only when an edit is
 * pending. Esc and a click outside close it; Enter in a field applies, and
 * Ctrl/⌘ with it asks for a new session whatever changed.
 */

/** What Apply would do with the edits in the popup now. */
export type PendingChange = 'none' | 'live' | 'reload';

type Handler = (e: Event) => void;

/** The slice of an element the popup touches. */
export interface PopupElement {
  hidden: boolean;
  contains(node: unknown): boolean;
  addEventListener(type: string, fn: Handler): void;
}

export interface PopupButton extends PopupElement {
  textContent: string | null;
  setAttribute(name: string, value: string): void;
}

export interface PopupDetails {
  open: boolean;
  addEventListener(type: string, fn: Handler): void;
}

export interface SettingsPopupOptions {
  button: PopupButton;
  popup: PopupElement;
  applyButton: PopupButton;
  /** Advanced section; its open state is remembered per tab under `storageKey`. */
  advanced?: PopupDetails;
  storageKey: string;
  pending: () => PendingChange;
  /** Apply's label when the edits need a new session or broadcast. */
  reloadLabel?: string;
  /** Before the popup shows: fill the fields from the page's current settings. */
  onOpen?: () => void;
  /** `forceReload`: Ctrl/⌘ was held. */
  onApply: (forceReload: boolean) => void;
}

export interface SettingsPopup {
  readonly isOpen: boolean;
  open(): void;
  close(): void;
  /** Re-reads `pending()` for Apply's visibility and label. */
  refresh(): void;
}

export interface PopupDocument {
  addEventListener(type: string, fn: Handler): void;
}

/** Keeps a <details> open or closed across this tab's reloads. */
export function rememberOpen(details: PopupDetails, key: string, storage: Storage | null = sessionStorageOrNull()): void {
  try {
    const stored = storage?.getItem(key);
    if (stored === '1' || stored === '0') details.open = stored === '1';
  } catch { /* storage unavailable */ }
  details.addEventListener('toggle', () => {
    try { storage?.setItem(key, details.open ? '1' : '0'); } catch { /* storage unavailable */ }
  });
}

export function attachSettingsPopup(
  o: SettingsPopupOptions,
  doc: PopupDocument = document,
  storage: Storage | null = sessionStorageOrNull(),
): SettingsPopup {
  const applyLabel = o.applyButton.textContent ?? 'Apply';
  if (o.advanced) rememberOpen(o.advanced, `${o.storageKey}:advanced`, storage);

  const refresh = (): void => {
    const pending = o.pending();
    o.applyButton.hidden = pending === 'none';
    o.applyButton.textContent = pending === 'reload' && o.reloadLabel ? o.reloadLabel : applyLabel;
  };
  const setOpen = (open: boolean): void => {
    if (open) o.onOpen?.();
    o.popup.hidden = !open;
    o.button.setAttribute('aria-expanded', String(open));
    if (open) {
      refresh();
      fitViewport(o.popup);
    }
  };
  const popup: SettingsPopup = {
    get isOpen() { return !o.popup.hidden; },
    open: () => setOpen(true),
    close: () => setOpen(false),
    refresh,
  };

  o.button.addEventListener('click', () => setOpen(o.popup.hidden));
  o.applyButton.addEventListener('click', (e) => {
    const m = e as MouseEvent;
    o.onApply(m.ctrlKey === true || m.metaKey === true);
  });
  o.popup.addEventListener('input', refresh);
  o.popup.addEventListener('change', refresh);
  // Pickers and buttons that set a field from code fire no input event.
  o.popup.addEventListener('click', refresh);
  o.popup.addEventListener('keydown', (e) => {
    const k = e as KeyboardEvent;
    if (k.key !== 'Enter' || k.isComposing) return;
    const tag = (k.target as { tagName?: string } | null)?.tagName;
    if (tag !== 'INPUT' && tag !== 'SELECT') return;
    k.preventDefault();
    o.onApply(k.ctrlKey === true || k.metaKey === true);
  });
  doc.addEventListener('keydown', (e) => {
    if ((e as KeyboardEvent).key === 'Escape' && popup.isOpen) setOpen(false);
  });
  doc.addEventListener('click', (e) => {
    if (!popup.isOpen) return;
    const t = e.target;
    if (!o.popup.contains(t) && !o.button.contains(t)) setOpen(false);
  });
  return popup;
}

/** Shortens the popup so it stays inside the viewport whichever way it opens. */
function fitViewport(popup: PopupElement): void {
  const el = popup as unknown as HTMLElement;
  if (typeof el.getBoundingClientRect !== 'function' || !el.style || typeof window === 'undefined') return;
  el.style.maxHeight = '';
  const r = el.getBoundingClientRect();
  const margin = 8;
  const over = Math.max(margin - r.top, r.bottom - (window.innerHeight - margin));
  if (over > 0) el.style.maxHeight = `${Math.max(160, r.height - over)}px`;
}

function sessionStorageOrNull(): Storage | null {
  try { return typeof sessionStorage === 'undefined' ? null : sessionStorage; } catch { return null; }
}
