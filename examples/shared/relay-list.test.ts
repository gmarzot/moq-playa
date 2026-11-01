import { describe, expect, it } from 'vitest';
import { attachRelayPicker, DEFAULT_RELAY, KNOWN_RELAYS } from './relay-list.js';

type Listener = (e: { target?: unknown; key?: string; stopPropagation(): void }) => void;

/** The slice of the DOM attachRelayPicker touches. */
interface FakeEl {
  value: string;
  textContent: string;
  title: string;
  className: string;
  type: string;
  hidden: boolean;
  focused: boolean;
  attrs: Record<string, string>;
  children: FakeEl[];
  parentNode: null | { insertBefore: (a: FakeEl, b: FakeEl) => void };
  setAttribute(name: string, value: string): void;
  appendChild(c: FakeEl): void;
  contains(n: unknown): boolean;
  focus(): void;
  addEventListener(type: string, fn: Listener): void;
  fire(type: string, init?: { target?: unknown; key?: string }): void;
}

function fakeListeners() {
  const listeners: Record<string, Listener[]> = {};
  return {
    addEventListener(type: string, fn: Listener) { (listeners[type] ??= []).push(fn); },
    fire(type: string, init: { target?: unknown; key?: string } = {}) {
      for (const fn of listeners[type] ?? []) fn({ ...init, stopPropagation() {} });
    },
  };
}

function fakeEl(): FakeEl {
  const el: FakeEl = {
    value: '', textContent: '', title: '', className: '', type: '', hidden: false, focused: false,
    attrs: {},
    children: [],
    parentNode: null,
    setAttribute(name, value) { el.attrs[name] = value; },
    appendChild(c) { el.children.push(c); },
    contains(n) { return n === el || el.children.some((c) => c.contains(n)); },
    focus() { el.focused = true; },
    ...fakeListeners(),
  };
  return el;
}

function setup(initial = '') {
  const inserted: FakeEl[] = [];
  const input = fakeEl();
  input.value = initial;
  input.parentNode = { insertBefore: (a) => { inserted.push(a); } };
  const doc = { createElement: () => fakeEl(), ...fakeListeners() };
  const picker = attachRelayPicker(input as unknown as HTMLInputElement, doc as unknown as Document);
  const wrap = inserted[0]!;
  const [, button, menu] = wrap.children as [FakeEl, FakeEl, FakeEl];
  return { input, wrap, button, menu, items: menu.children, picker, doc };
}

describe('KNOWN_RELAYS', () => {
  it('moqx-main is first and is the default', () => {
    expect(KNOWN_RELAYS[0]!).toBe('https://moqx-main.ci.openmoq.org:4433/moq-relay');
    expect(DEFAULT_RELAY).toBe(KNOWN_RELAYS[0]!);
  });

  it('every entry is an https (WebTransport) URL, listed once', () => {
    for (const url of KNOWN_RELAYS) expect(new URL(url).protocol).toBe('https:');
    expect(new Set(KNOWN_RELAYS).size).toBe(KNOWN_RELAYS.length);
  });
});

describe('attachRelayPicker', () => {
  it('wraps the input on one line with a closed menu listing every known relay by URL', () => {
    const { input, wrap, button, menu, items } = setup();
    expect(wrap.className).toBe('relay-combo');
    expect(wrap.children[0]).toBe(input);
    expect(button.attrs['aria-expanded']).toBe('false');
    expect(menu.hidden).toBe(true);
    expect(items.map((i) => i.textContent)).toEqual([...KNOWN_RELAYS]);
  });

  it('the button toggles the menu', () => {
    const { button, menu } = setup();
    button.fire('click');
    expect(menu.hidden).toBe(false);
    expect(button.attrs['aria-expanded']).toBe('true');
    button.fire('click');
    expect(menu.hidden).toBe(true);
  });

  it('choosing an entry fills the input, closes the menu and focuses the input', () => {
    const { input, button, menu, items } = setup('https://relay.example.com:4433/moq');
    button.fire('click');
    items[1]!.fire('click');
    expect(input.value).toBe(KNOWN_RELAYS[1]!);
    expect(menu.hidden).toBe(true);
    expect(input.focused).toBe(true);
    expect(items.map((i) => i.attrs['aria-selected'])).toEqual(['false', 'true']);
  });

  it('a typed URL stays as typed and selects no entry', () => {
    const { input, items, picker } = setup(DEFAULT_RELAY);
    expect(items[0]!.attrs['aria-selected']).toBe('true');
    input.value = 'https://relay.example.com:4433/moq';
    input.fire('input');
    expect(input.value).toBe('https://relay.example.com:4433/moq');
    expect(items.every((i) => i.attrs['aria-selected'] === 'false')).toBe(true);
    input.value = KNOWN_RELAYS[1]!;
    picker.sync();
    expect(items[1]!.attrs['aria-selected']).toBe('true');
  });

  it('a click outside or Escape closes the menu', () => {
    const { wrap, button, menu, doc } = setup();
    button.fire('click');
    doc.fire('click', { target: button });
    expect(menu.hidden).toBe(false);
    doc.fire('click', { target: {} });
    expect(menu.hidden).toBe(true);
    button.fire('click');
    wrap.fire('keydown', { key: 'Escape' });
    expect(menu.hidden).toBe(true);
    expect(button.focused).toBe(true);
  });
});
