import { afterEach, describe, expect, it, vi } from 'vitest';
import { copyOnClick } from './copyable.js';

/** The slice of an element copyOnClick touches. */
function fakeElement(text: string) {
  const classes = new Set<string>();
  let onClick: (() => void) | null = null;
  return {
    textContent: text,
    title: '',
    classList: {
      add: (c: string) => { classes.add(c); },
      remove: (c: string) => { classes.delete(c); },
      contains: (c: string) => classes.has(c),
    },
    addEventListener: (_type: string, fn: () => void) => { onClick = fn; },
    click: () => onClick?.(),
  };
}

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('copyOnClick', () => {
  it('copies the current text and shows the copied state briefly', async () => {
    vi.useFakeTimers();
    const writeText = vi.fn(async () => {});
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    const el = fakeElement('https://relay.example.com:4433/moq-relay');
    copyOnClick(el as unknown as HTMLElement);
    expect(el.classList.contains('copyable')).toBe(true);

    el.textContent = 'https://other.example.com:4433/moq-relay';   // set after load
    el.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(writeText).toHaveBeenCalledWith('https://other.example.com:4433/moq-relay');
    expect(el.classList.contains('copied')).toBe(true);

    await vi.advanceTimersByTimeAsync(1_200);
    expect(el.classList.contains('copied')).toBe(false);
  });

  it('selects the text when the clipboard refuses the write', async () => {
    const addRange = vi.fn();
    vi.stubGlobal('navigator', { clipboard: { writeText: async () => { throw new Error('denied'); } } });
    vi.stubGlobal('document', { createRange: () => ({ selectNodeContents: vi.fn() }) });
    vi.stubGlobal('window', { getSelection: () => ({ removeAllRanges: vi.fn(), addRange }) });
    const el = fakeElement('live/demo');
    copyOnClick(el as unknown as HTMLElement);

    el.click();
    await new Promise((r) => setTimeout(r, 0));
    expect(addRange).toHaveBeenCalledOnce();
    expect(el.classList.contains('copied')).toBe(false);
  });
});
