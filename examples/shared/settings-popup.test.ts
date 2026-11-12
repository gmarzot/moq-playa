import { describe, expect, it, vi } from 'vitest';
import { attachSettingsPopup, rememberOpen, type PendingChange } from './settings-popup.js';

type Handler = (e: Event) => void;

function fakeTarget() {
  const listeners: Record<string, Handler[]> = {};
  return {
    addEventListener(type: string, fn: Handler) { (listeners[type] ??= []).push(fn); },
    fire(type: string, init: Record<string, unknown> = {}) {
      const e = { preventDefault: vi.fn(), ...init } as unknown as Event;
      for (const fn of listeners[type] ?? []) fn(e);
      return e;
    },
  };
}

function fakeEl(inside: unknown[] = []) {
  const attrs: Record<string, string> = {};
  const el = {
    ...fakeTarget(),
    hidden: true,
    textContent: 'Apply' as string | null,
    attrs,
    setAttribute(name: string, value: string) { attrs[name] = value; },
    contains(node: unknown) { return node === el || inside.includes(node); },
  };
  return el;
}

function fakeStorage(): Storage {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => { m.set(k, v); },
    removeItem: (k: string) => { m.delete(k); },
    clear: () => m.clear(), key: () => null, get length() { return m.size; },
  };
}

function setup(pending: PendingChange = 'none') {
  const field = { tagName: 'INPUT' };
  const button = fakeEl();
  const popup = fakeEl([field]);
  const applyButton = fakeEl();
  const doc = fakeTarget();
  const state = { pending };
  const onOpen = vi.fn();
  const onApply = vi.fn();
  const p = attachSettingsPopup({
    button, popup, applyButton, storageKey: 'test', pending: () => state.pending,
    reloadLabel: 'Apply · reloads', onOpen, onApply,
  }, doc, fakeStorage());
  return { p, button, popup, applyButton, doc, field, state, onOpen, onApply };
}

describe('attachSettingsPopup', () => {
  it('the gear toggles it, filling the fields on open', () => {
    const s = setup();
    s.button.fire('click', { target: s.button });
    expect(s.p.isOpen).toBe(true);
    expect(s.onOpen).toHaveBeenCalledOnce();
    expect(s.button.attrs['aria-expanded']).toBe('true');
    s.button.fire('click', { target: s.button });
    expect(s.p.isOpen).toBe(false);
  });

  it('Esc and a click outside close it; a click inside does not', () => {
    const s = setup();
    s.p.open();
    s.doc.fire('click', { target: s.field });
    expect(s.p.isOpen).toBe(true);
    s.doc.fire('click', { target: {} });
    expect(s.p.isOpen).toBe(false);
    s.p.open();
    s.doc.fire('keydown', { key: 'Escape' });
    expect(s.p.isOpen).toBe(false);
  });

  it('shows Apply only while an edit is pending, labelled for a reload', () => {
    const s = setup();
    s.p.open();
    expect(s.applyButton.hidden).toBe(true);
    s.state.pending = 'live';
    s.popup.fire('input', { target: s.field });
    expect(s.applyButton.hidden).toBe(false);
    expect(s.applyButton.textContent).toBe('Apply');
    s.state.pending = 'reload';
    s.popup.fire('change', { target: s.field });
    expect(s.applyButton.textContent).toBe('Apply · reloads');
    s.state.pending = 'none';
    s.popup.fire('click', { target: s.field });                 // a picker set the field back
    expect(s.applyButton.hidden).toBe(true);
  });

  it('Apply and Enter in a field apply; Ctrl/⌘ asks for a reload', () => {
    const s = setup('live');
    s.p.open();
    s.applyButton.fire('click', { ctrlKey: false, metaKey: false });
    expect(s.onApply).toHaveBeenLastCalledWith(false);
    const e = s.popup.fire('keydown', { key: 'Enter', target: s.field, metaKey: true });
    expect(s.onApply).toHaveBeenLastCalledWith(true);
    expect(e.preventDefault).toHaveBeenCalled();
    s.popup.fire('keydown', { key: 'Enter', target: { tagName: 'BUTTON' } });
    expect(s.onApply).toHaveBeenCalledTimes(2);
  });
});

describe('rememberOpen', () => {
  it('restores a disclosure this tab opened', () => {
    const storage = fakeStorage();
    const a = { open: false, ...fakeTarget() };
    rememberOpen(a, 'k', storage);
    a.open = true;
    a.fire('toggle');
    const b = { open: false, ...fakeTarget() };
    rememberOpen(b, 'k', storage);
    expect(b.open).toBe(true);
  });
});
