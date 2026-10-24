import { describe, expect, it } from 'vitest';
import { attachRelayPicker, DEFAULT_RELAY, KNOWN_RELAYS } from './relay-list.js';

/** The slice of the DOM attachRelayPicker touches. */
interface FakeEl {
  value: string;
  textContent: string;
  title: string;
  style: Record<string, string>;
  children: FakeEl[];
  parentNode: null | { insertBefore: (a: unknown, b: unknown) => void };
  appendChild(c: FakeEl): void;
  addEventListener(type: string, fn: () => void): void;
  fire(type: string): void;
}

function fakeEl(): FakeEl {
  const listeners: Record<string, Array<() => void>> = {};
  const el: FakeEl = {
    value: '',
    textContent: '',
    title: '',
    style: {},
    children: [],
    parentNode: null,
    appendChild(c) { el.children.push(c); },
    addEventListener(type, fn) { (listeners[type] ??= []).push(fn); },
    fire(type) { for (const fn of listeners[type] ?? []) fn(); },
  };
  return el;
}

function setup(initial = '') {
  const inserted: unknown[] = [];
  const input = fakeEl();
  input.value = initial;
  input.parentNode = { insertBefore: (a: unknown) => { inserted.push(a); } };
  const doc = { createElement: () => fakeEl() };
  const picker = attachRelayPicker(input as unknown as HTMLInputElement, doc as unknown as Document);
  const select = picker.select as unknown as FakeEl;
  return { input, select, picker, inserted };
}

describe('KNOWN_RELAYS', () => {
  it('moqx-main is first and is the default', () => {
    expect(KNOWN_RELAYS[0]!.url).toBe('https://moqx-main.ci.openmoq.org:4433/moq-relay');
    expect(DEFAULT_RELAY).toBe(KNOWN_RELAYS[0]!.url);
  });

  it('every entry is an https (WebTransport) URL with a label, listed once', () => {
    for (const r of KNOWN_RELAYS) {
      expect(new URL(r.url).protocol).toBe('https:');
      expect(r.label).not.toBe('');
    }
    expect(new Set(KNOWN_RELAYS.map((r) => r.url)).size).toBe(KNOWN_RELAYS.length);
  });
});

describe('attachRelayPicker', () => {
  it('inserts a select offering every known relay, then "Other"', () => {
    const { select, inserted } = setup();
    expect(inserted).toEqual([select]);
    expect(select.children.map((o) => o.value)).toEqual([...KNOWN_RELAYS.map((r) => r.url), '']);
  });

  it('selects the entry matching the input, or "Other" for a typed URL', () => {
    const { input, select, picker } = setup(DEFAULT_RELAY);
    expect(select.value).toBe(DEFAULT_RELAY);
    input.value = 'https://relay.example.com:4433/moq';
    input.fire('input');
    expect(select.value).toBe('');
    input.value = KNOWN_RELAYS[1]!.url;
    picker.sync();
    expect(select.value).toBe(KNOWN_RELAYS[1]!.url);
  });

  it('choosing an entry fills the input; "Other" leaves it for typing', () => {
    const { input, select } = setup('https://relay.example.com:4433/moq');
    select.value = KNOWN_RELAYS[1]!.url;
    select.fire('change');
    expect(input.value).toBe(KNOWN_RELAYS[1]!.url);
    select.value = '';
    select.fire('change');
    expect(input.value).toBe(KNOWN_RELAYS[1]!.url);
  });
});
