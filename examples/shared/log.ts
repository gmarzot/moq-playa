/** Lines kept; the oldest are dropped past this. */
const MAX_LOG_LINES = 2000;

/** Append a line to the <pre id="log"> element. */
export function log(msg: string): void {
  const el = document.getElementById('log');
  if (!el) return;
  const ts = new Date().toISOString().slice(11, 23); // HH:MM:SS.mmm
  el.append(`[${ts}] ${msg}\n`);
  while (el.childNodes.length > MAX_LOG_LINES) el.firstChild!.remove();
  el.scrollTop = el.scrollHeight;
}

/** Clear the log element. */
export function clearLog(): void {
  const el = document.getElementById('log');
  if (el) el.textContent = '';
}
