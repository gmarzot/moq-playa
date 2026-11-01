/**
 * Relays the G5 pages offer in their relay URL field, listed by URL. The first is the default.
 */
export const KNOWN_RELAYS: readonly string[] = [
  'https://moqx-main.ci.openmoq.org:4433/moq-relay',
  'https://aiomoqt-relay.marzresearch.net:4443/',
];

export const DEFAULT_RELAY: string = KNOWN_RELAYS[0]!;

export interface RelayPicker {
  readonly select: HTMLSelectElement;
  /** Re-select the entry matching the input's current value (or "Other"). */
  sync(): void;
}

/**
 * Put a picker of KNOWN_RELAYS before `input`. Choosing an entry fills the
 * input; typing any other URL selects "Other". Call `sync()` after setting the
 * input's value from code.
 */
export function attachRelayPicker(input: HTMLInputElement, doc: Document = document): RelayPicker {
  const select = doc.createElement('select');
  select.title = 'Known relays; choosing one fills the URL below';
  select.style.marginBottom = '6px';
  const option = (value: string, text: string): void => {
    const o = doc.createElement('option');
    o.value = value;
    o.textContent = text;
    select.appendChild(o);
  };
  for (const url of KNOWN_RELAYS) option(url, url);
  option('', 'Other (type a URL below)');

  const sync = (): void => {
    const url = input.value.trim();
    select.value = KNOWN_RELAYS.includes(url) ? url : '';
  };
  select.addEventListener('change', () => {
    if (select.value) input.value = select.value;
  });
  input.addEventListener('input', sync);
  input.parentNode?.insertBefore(select, input);
  sync();
  return { select, sync };
}
