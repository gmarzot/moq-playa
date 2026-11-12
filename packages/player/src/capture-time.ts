/**
 * Wall-clock capture times from an object's timing metadata, for latency
 * measurement only; playout keeps using `LocHeaders.captureTimestamp`.
 *
 * @see draft-frindell-moq-timestamp-00 (code points provisional)
 * @see draft-ietf-moq-loc-04 §2.3.1.2
 * @see ISO/IEC 14496-12 §8.16.5 (ProducerReferenceTimeBox)
 * @module
 */

import { decodePropertyBlock, readVi64 } from '@openmoq/transport';
import type { PropertyWireProfile } from '@openmoq/transport';
import { deserializeLocmafObject, zigzagDecode } from '@openmoq/locmaf';
import type { LocmafObject } from '@openmoq/locmaf';

/** @see draft-frindell-moq-timestamp-00 §9 */
export const TIMESTAMP_PROPERTY = {
  timescale: 0x2c7a51e0n,
  clockId: 0x3e8d2b70n,
  timestampOrigin: 0x31b49a6en,
  timestampMapping: 0x27f308c5n,
  objectTimestamp: 0x2d1an,
} as const;

const NAMES = new Map<bigint, string>([
  [TIMESTAMP_PROPERTY.timescale, 'TIMESCALE'],
  [TIMESTAMP_PROPERTY.clockId, 'CLOCK_ID'],
  [TIMESTAMP_PROPERTY.timestampOrigin, 'TIMESTAMP_ORIGIN'],
  [TIMESTAMP_PROPERTY.timestampMapping, 'TIMESTAMP_MAPPING'],
  [TIMESTAMP_PROPERTY.objectTimestamp, 'OBJECT_TIMESTAMP'],
]);

const TRACK_SCOPE: readonly bigint[] = [
  TIMESTAMP_PROPERTY.timescale,
  TIMESTAMP_PROPERTY.clockId,
  TIMESTAMP_PROPERTY.timestampOrigin,
  TIMESTAMP_PROPERTY.timestampMapping,
];

const MAX_U64 = (1n << 64n) - 1n;
const NTP_UNIX_OFFSET_S = 2_208_988_800n;

/** §4.4, all in ticks. */
export interface TimestampMapping {
  readonly baseGroup: bigint;
  readonly baseTimestamp: bigint;
  readonly groupMultiplier: bigint;
  readonly objectMultiplier: bigint;
}

/** A track's timestamp declaration (§4). */
export interface TimestampTrack {
  readonly timescale: bigint;
  readonly mapping?: TimestampMapping;
  readonly clockId?: bigint;
  readonly origin?: bigint;
}

/** A track's declaration, or why the track is malformed. */
export type TimestampTrackResult = TimestampTrack | { readonly error: string };

/** Wall-clock capture times, µs since the epoch, by source. */
export interface CaptureTimes {
  /** MOQT timestamp properties: the mapping plus correction, or OBJECT_TIMESTAMP. */
  readonly property?: number;
  /** LOC Timestamp without a Timescale. */
  readonly loc?: number;
  /** NTP time of a CMAF prft box. */
  readonly prft?: number;
}

export type CaptureTimeSource = keyof CaptureTimes;

/** A value, an error, or neither. */
export interface TimingResult<T> {
  readonly value?: T;
  readonly error?: string;
}

const name = (id: bigint): string => NAMES.get(id) ?? `0x${id.toString(16)}`;

/**
 * Read the timestamp Track Properties (§3, §4). Undefined when the track
 * declares none.
 */
export function parseTimestampTrack(
  props: ReadonlyMap<bigint, readonly unknown[]> | undefined,
): TimestampTrackResult | undefined {
  if (!props) return undefined;
  if (props.has(TIMESTAMP_PROPERTY.objectTimestamp)) {
    return { error: 'OBJECT_TIMESTAMP as a Track Property' };
  }
  const values = new Map<bigint, unknown>();
  for (const id of TRACK_SCOPE) {
    const v = props.get(id);
    if (!v || v.length === 0) continue;
    if (v.length > 1) return { error: `${name(id)} appears more than once` };
    values.set(id, v[0]);
  }
  if (values.size === 0) return undefined;

  const timescale = values.get(TIMESTAMP_PROPERTY.timescale);
  if (typeof timescale !== 'bigint' || timescale === 0n) return { error: 'TIMESCALE missing or 0' };
  const clockId = values.get(TIMESTAMP_PROPERTY.clockId);
  const origin = values.get(TIMESTAMP_PROPERTY.timestampOrigin);
  if (clockId !== undefined && typeof clockId !== 'bigint') return { error: 'CLOCK_ID is not an integer' };
  if (origin !== undefined && typeof origin !== 'bigint') return { error: 'TIMESTAMP_ORIGIN is not an integer' };
  if (origin !== undefined && clockId === undefined) return { error: 'TIMESTAMP_ORIGIN without CLOCK_ID' };

  const raw = values.get(TIMESTAMP_PROPERTY.timestampMapping);
  let mapping: TimestampMapping | undefined;
  if (raw !== undefined) {
    mapping = raw instanceof Uint8Array ? readMapping(raw) : undefined;
    if (!mapping) return { error: 'TIMESTAMP_MAPPING is not four integers' };
  }
  return {
    timescale,
    ...(mapping ? { mapping } : {}),
    ...(clockId !== undefined ? { clockId } : {}),
    ...(origin !== undefined ? { origin } : {}),
  };
}

/** Exactly four vi64 values (§4.4). */
function readMapping(bytes: Uint8Array): TimestampMapping | undefined {
  const v: bigint[] = [];
  let pos = 0;
  try {
    while (pos < bytes.length && v.length < 4) {
      const r = readVi64(bytes, pos);
      v.push(r.value);
      pos += r.bytesRead;
    }
  } catch {
    return undefined;
  }
  if (v.length !== 4 || pos !== bytes.length) return undefined;
  return { baseGroup: v[0]!, baseTimestamp: v[1]!, groupMultiplier: v[2]!, objectMultiplier: v[3]! };
}

/** OBJECT_TIMESTAMP from an object's properties, enforcing the §3 scope and once-only rules. */
export function readObjectTimestamp(
  properties: Uint8Array | undefined,
  profile: PropertyWireProfile,
): TimingResult<bigint> {
  if (!properties || properties.length === 0) return {};
  let entries;
  try {
    ({ entries } = decodePropertyBlock(properties, 0, { profile }));
  } catch (err) {
    return { error: `object properties: ${err instanceof Error ? err.message : String(err)}` };
  }
  let value: bigint | undefined;
  for (const { id, value: v } of entries) {
    if (id === TIMESTAMP_PROPERTY.objectTimestamp) {
      if (value !== undefined) return { error: 'OBJECT_TIMESTAMP appears more than once' };
      if (typeof v !== 'bigint') return { error: 'OBJECT_TIMESTAMP is not an integer' };
      value = v;
    } else if (TRACK_SCOPE.includes(id)) {
      return { error: `${name(id)} as an Object Property` };
    }
  }
  return value === undefined ? {} : { value };
}

/** Error for timestamp properties on an object whose track declared none (§3, §4.1). */
export function undeclaredTimestampError(ids: ReadonlyMap<bigint, unknown> | undefined): string | undefined {
  if (!ids) return undefined;
  for (const id of TRACK_SCOPE) {
    if (ids.has(id)) return `${name(id)} as an Object Property`;
  }
  return ids.has(TIMESTAMP_PROPERTY.objectTimestamp) ? 'OBJECT_TIMESTAMP without TIMESCALE' : undefined;
}

/**
 * An object's capture time in µs since the epoch (§4.2-§5). No value when the
 * object has no timestamp or the track's clock is not wall clock.
 *
 * @param objectTimestamp OBJECT_TIMESTAMP as carried: a zig-zag correction on a mapped track.
 */
export function propertyCaptureUs(
  track: TimestampTrack,
  groupId: bigint,
  objectId: bigint,
  objectTimestamp?: bigint,
): TimingResult<bigint> {
  const m = track.mapping;
  let ts: bigint;
  if (m) {
    ts = m.baseTimestamp + (groupId - m.baseGroup) * m.groupMultiplier + objectId * m.objectMultiplier
      + (objectTimestamp === undefined ? 0n : zigzagDecode(objectTimestamp));
  } else if (objectTimestamp !== undefined) {
    ts = objectTimestamp;
  } else {
    return {};
  }
  if (ts < 0n || ts > MAX_U64) return { error: `timestamp ${ts} outside 0..2^64-1` };
  // CLOCK_ID absent or 0 is POSIX time (§4.2, §9.2, Appendix A.1).
  if (track.clockId !== undefined && track.clockId !== 0n) return {};
  return { value: ((track.origin ?? 0n) + ts) * 1_000_000n / track.timescale };
}

/** NTP time of the first top-level prft box, µs since the epoch. */
export function readPrftUs(payload: Uint8Array): bigint | undefined {
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const len = payload.byteLength;
  let pos = 0;
  while (pos + 8 <= len) {
    let size = view.getUint32(pos);
    let header = 8;
    if (size === 1) {
      if (pos + 16 > len) return undefined;
      size = Number(view.getBigUint64(pos + 8));
      header = 16;
    } else if (size === 0) {
      size = len - pos;
    }
    if (size < header) return undefined;
    if (payload[pos + 4] === 0x70 && payload[pos + 5] === 0x72
        && payload[pos + 6] === 0x66 && payload[pos + 7] === 0x74) {
      return prftBodyUs(payload.subarray(pos + header, Math.min(pos + size, len)));
    }
    pos += size;
  }
  return undefined;
}

/** NTP time of a prft in a LOCMAF Object: a genBox, or a box of a rawBoxes Object. */
export function readLocmafPrftUs(payload: Uint8Array): bigint | undefined {
  let obj: LocmafObject;
  try {
    obj = deserializeLocmafObject(payload);
  } catch {
    return undefined;
  }
  if (obj.kind === 'rawBoxes') return readPrftUs(obj.boxes);
  const box = obj.genBoxes.find((b) => b.type === 'prft');
  return box ? prftBodyUs(box.payload) : undefined;
}

/** A prft body (after the box header): version/flags, reference_track_ID, then the 64-bit NTP time. */
function prftBodyUs(body: Uint8Array): bigint | undefined {
  if (body.byteLength < 16) return undefined;
  const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
  const sec = BigInt(view.getUint32(8));
  const frac = BigInt(view.getUint32(12));
  if (sec < NTP_UNIX_OFFSET_S) return undefined;
  return (sec - NTP_UNIX_OFFSET_S) * 1_000_000n + ((frac * 1_000_000n) >> 32n);
}

const ORDER: readonly CaptureTimeSource[] = ['property', 'loc', 'prft'];

/** The capture time latency is measured against: properties, then LOC, then prft. */
export function pickCaptureTime(
  times: CaptureTimes | undefined,
): { readonly source: CaptureTimeSource; readonly us: number } | undefined {
  if (!times) return undefined;
  for (const source of ORDER) {
    const us = times[source];
    if (us !== undefined) return { source, us };
  }
  return undefined;
}
