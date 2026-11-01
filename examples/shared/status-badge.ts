/**
 * MoQT state badges: one short MoQT word, its colour carrying the state —
 * grey idle, yellow waiting or paused, green flowing, red fault.
 */
export type BadgeTone = 'idle' | 'wait' | 'ok' | 'bad';

/** Show `text` in `tone`, with the MoQT detail as its tooltip. */
export function setBadge(el: HTMLElement, text: string, tone: BadgeTone, detail: string): void {
  if (el.textContent !== text) el.textContent = text;
  el.className = `badge ${tone}`;
  el.title = detail;
}
