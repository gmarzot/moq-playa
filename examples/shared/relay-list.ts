/**
 * Relays the G5 pages offer in their relay URL field, listed by URL. The first is the default.
 */
export const KNOWN_RELAYS: readonly string[] = [
  'https://moqx-main.ci.openmoq.org:4433/moq-relay',
  'https://aiomoqt-relay.marzresearch.net:4443/',
];

export const DEFAULT_RELAY: string = KNOWN_RELAYS[0]!;

export interface RelayPicker {
  /** Mark the menu entry matching the input's current value. */
  sync(): void;
}

/**
 * Make `input` a one-line relay field: it takes any typed or pasted URL, and a
 * ▾ button beside it opens a menu of KNOWN_RELAYS; choosing one fills the
 * field. Call `sync()` after setting the input's value from code.
 */
export function attachRelayPicker(input: HTMLInputElement, doc: Document = document): RelayPicker {
  const wrap = doc.createElement('div');
  wrap.className = 'relay-combo';
  const button = doc.createElement('button');
  button.type = 'button';
  button.className = 'relay-combo-btn';
  button.textContent = '▾';
  button.title = 'Known relays';
  button.setAttribute('aria-haspopup', 'listbox');
  button.setAttribute('aria-expanded', 'false');
  const menu = doc.createElement('div');
  menu.className = 'relay-combo-menu';
  menu.setAttribute('role', 'listbox');
  menu.hidden = true;

  const setOpen = (open: boolean): void => {
    menu.hidden = !open;
    button.setAttribute('aria-expanded', String(open));
  };
  const items = KNOWN_RELAYS.map((url) => {
    const item = doc.createElement('button');
    item.type = 'button';
    item.className = 'relay-combo-item';
    item.setAttribute('role', 'option');
    item.textContent = url;
    item.addEventListener('click', () => {
      input.value = url;
      sync();
      setOpen(false);
      input.focus();
    });
    menu.appendChild(item);
    return item;
  });
  const sync = (): void => {
    const url = input.value.trim();
    KNOWN_RELAYS.forEach((known, i) => items[i]!.setAttribute('aria-selected', String(known === url)));
  };

  button.addEventListener('click', () => setOpen(menu.hidden));
  input.addEventListener('input', sync);
  doc.addEventListener('click', (e) => {
    if (!menu.hidden && !wrap.contains(e.target as Node)) setOpen(false);
  });
  wrap.addEventListener('keydown', (e) => {
    if ((e as KeyboardEvent).key === 'Escape' && !menu.hidden) {
      e.stopPropagation();
      setOpen(false);
      button.focus();
    }
  });

  input.parentNode?.insertBefore(wrap, input);
  wrap.appendChild(input);
  wrap.appendChild(button);
  wrap.appendChild(menu);
  sync();
  return { sync };
}
