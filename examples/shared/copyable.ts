/**
 * Click-to-copy for a short value shown on a page (relay URL, namespace).
 */

/** How long the copied state shows. */
const COPIED_MS = 1_200;

/**
 * Copy `el`'s current text to the clipboard when it is clicked, and mark it
 * with the `copied` class briefly. Where the clipboard refuses the write, the
 * text is selected instead so it can be copied by hand.
 */
export function copyOnClick(el: HTMLElement): void {
  el.classList.add('copyable');
  el.title = 'Click to copy';
  let timer: ReturnType<typeof setTimeout> | null = null;
  el.addEventListener('click', () => {
    const text = el.textContent ?? '';
    if (!text) return;
    void copyText(text).then((ok) => {
      if (!ok) {
        selectContents(el);
        return;
      }
      el.classList.add('copied');
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        el.classList.remove('copied');
        timer = null;
      }, COPIED_MS);
    });
  });
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // No clipboard outside a secure context, or permission refused.
    return false;
  }
}

function selectContents(el: HTMLElement): void {
  const range = document.createRange();
  range.selectNodeContents(el);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}
