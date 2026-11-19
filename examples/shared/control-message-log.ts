/**
 * One MoQT control message as a log line: its type, then its fields, with
 * message and setup parameters by name.
 */
import { MessageParam, SetupParam } from '@openmoq/transport';

/** Parameter names by type code; the first name wins where drafts share a code. */
function namesOf(params: Record<string, bigint>): ReadonlyMap<bigint, string> {
  const names = new Map<bigint, string>();
  for (const [name, code] of Object.entries(params)) {
    if (!names.has(BigInt(code))) names.set(BigInt(code), name);
  }
  return names;
}
const PARAM_NAMES = namesOf(MessageParam);
const SETUP_NAMES = namesOf(SetupParam);
const SETUP_TYPES = new Set(['CLIENT_SETUP', 'SERVER_SETUP', 'SETUP']);

const MAX_TEXT_BYTES = 64;
/** AUTHORIZATION_TOKEN, in message parameters and setup options alike. */
const AUTH_TOKEN_CODE = 0x03n;
const REDACTED = '<redacted>';
const isTokenKey = (key: string): boolean => /token/i.test(key);

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
    return `{${Object.entries(v).filter(([, x]) => x !== undefined)
      .map(([k, x]) => `${k}:${isTokenKey(k) ? REDACTED : describeValue(x, depth + 1)}`).join(' ')}}`;
  }
  return String(v);
}

function describeParameters(params: Map<unknown, unknown>, names: ReadonlyMap<bigint, string>): string {
  return [...params].map(([code, values]) => {
    const name = typeof code === 'bigint' ? (names.get(code) ?? `0x${code.toString(16)}`) : String(code);
    const list = Array.isArray(values) ? values : [values];
    if (code === AUTH_TOKEN_CODE) return `${name}=${REDACTED}×${list.length}`;
    return `${name}=${list.map((x) => describeValue(x)).join(',')}`;
  }).join(' ');
}


export function describeControlMessage(message: unknown, maxChars = 300): string {
  if (message === null || typeof message !== 'object') return String(message);
  const { type, ...fields } = message as Record<string, unknown>;
  // trackExtensions is the deprecated alias of trackProperties.
  if (fields['trackProperties'] !== undefined) delete fields['trackExtensions'];
  const parts = [String(type)];
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || (value instanceof Map && value.size === 0)) continue;
    if ((key === 'parameters' || key === 'setupOptions') && value instanceof Map) {
      const setup = key === 'setupOptions' || SETUP_TYPES.has(String(type));
      parts.push(describeParameters(value, setup ? SETUP_NAMES : PARAM_NAMES));
    } else if (isTokenKey(key)) {
      parts.push(`${key}=${REDACTED}`);
    } else {
      parts.push(`${key}=${describeValue(value)}`);
    }
  }
  const line = parts.join(' ');
  return line.length > maxChars ? `${line.slice(0, maxChars - 1)}…` : line;
}
