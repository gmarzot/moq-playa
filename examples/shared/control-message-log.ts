/**
 * One MoQT control message as a log line: its type, then its fields, with
 * message parameters by name.
 */
import { MessageParam } from '@openmoq/transport';

/** MessageParam names by type code; the first name wins where drafts share a code. */
const PARAM_NAMES: ReadonlyMap<bigint, string> = (() => {
  const names = new Map<bigint, string>();
  for (const [name, code] of Object.entries(MessageParam)) {
    if (!names.has(BigInt(code))) names.set(BigInt(code), name);
  }
  return names;
})();

const MAX_TEXT_BYTES = 64;

function describeBytes(b: Uint8Array): string | null {
  if (b.byteLength > MAX_TEXT_BYTES || !b.every((c) => c >= 0x20 && c < 0x7f)) return null;
  return String.fromCharCode(...b);
}

function describeValue(v: unknown, depth = 0): string {
  if (v instanceof Uint8Array) {
    const text = describeBytes(v);
    return text === null ? `${v.byteLength}B` : `"${text}"`;
  }
  if (Array.isArray(v)) {
    // A namespace tuple reads as its path.
    const fields = v.every((x) => x instanceof Uint8Array) ? v.map((x) => describeBytes(x)) : null;
    if (fields && fields.every((x) => x !== null)) return fields.join('/');
    return `[${v.map((x) => describeValue(x, depth + 1)).join(',')}]`;
  }
  if (depth > 3) return '…';
  if (v instanceof Map) {
    return `{${[...v].map(([k, x]) => `${typeof k === 'bigint' ? `0x${k.toString(16)}` : String(k)}:${describeValue(x, depth + 1)}`).join(' ')}}`;
  }
  if (v !== null && typeof v === 'object') {
    return `{${Object.entries(v).filter(([, x]) => x !== undefined).map(([k, x]) => `${k}:${describeValue(x, depth + 1)}`).join(' ')}}`;
  }
  return String(v);
}

function describeParameters(params: Map<unknown, unknown>): string {
  return [...params].map(([code, values]) => {
    const name = typeof code === 'bigint' ? (PARAM_NAMES.get(code) ?? `0x${code.toString(16)}`) : String(code);
    const list = Array.isArray(values) ? values : [values];
    return `${name}=${list.map((x) => describeValue(x)).join(',')}`;
  }).join(' ');
}

export function describeControlMessage(message: unknown, maxChars = 300): string {
  if (message === null || typeof message !== 'object') return String(message);
  const { type, ...fields } = message as Record<string, unknown>;
  const parts = [String(type)];
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    if (key === 'parameters' && value instanceof Map) {
      if (value.size > 0) parts.push(describeParameters(value));
    } else {
      parts.push(`${key}=${describeValue(value)}`);
    }
  }
  const line = parts.join(' ');
  return line.length > maxChars ? `${line.slice(0, maxChars - 1)}…` : line;
}
