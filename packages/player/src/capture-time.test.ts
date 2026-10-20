/**
 * Tests for capture-time.ts and the SubscriptionManager / SUBSCRIBE_OK hooks.
 *
 * @see draft-frindell-moq-timestamp-00
 * @see ISO/IEC 14496-12 §8.16.5 (ProducerReferenceTimeBox)
 */

import { describe, it, expect, vi } from 'vitest';
import { encodePropertyBlock, writeVi64, vi64EncodingLength } from '@openmoq/transport';
import type { ControlMessage, MoqtObject } from '@openmoq/transport';
import { parseLocHeaders } from '@openmoq/loc';
import { zigzagEncode } from '@openmoq/locmaf';
import {
  TIMESTAMP_PROPERTY as P,
  parseTimestampTrack,
  propertyCaptureUs,
  readObjectTimestamp,
  undeclaredTimestampError,
  readPrftUs,
  pickCaptureTime,
} from './capture-time.js';
import type { TimestampTrack } from './capture-time.js';
import { SubscriptionManager } from './subscription-manager.js';
import { handleControlMessage, removeSubscription, type ControlMessageContext } from './player-message.js';

// 2026-10-20T00:00:00Z
const W = 1_792_454_400n;
const W_US = W * 1_000_000n;
const D18 = 'd18-delta-vi64' as const;

function vi64s(...values: bigint[]): Uint8Array {
  const out = new Uint8Array(values.reduce((n, v) => n + vi64EncodingLength(v), 0));
  let pos = 0;
  for (const v of values) pos += writeVi64(v, out, pos);
  return out;
}

function track(props: [bigint, unknown[]][]): TimestampTrack {
  const t = parseTimestampTrack(new Map(props));
  if (!t || 'error' in t) throw new Error(`expected a valid declaration, got ${JSON.stringify(t)}`);
  return t;
}

/** 29.97 fps, 60-frame groups, Group 1000 captured at W. */
const ntsc = (): TimestampTrack => track([
  [P.timescale, [30000n]],
  [P.timestampMapping, [vi64s(1000n, W * 30000n, 60060n, 1001n)]],
]);

describe('parseTimestampTrack', () => {
  it('reads TIMESCALE and the four mapping integers', () => {
    expect(ntsc()).toEqual({
      timescale: 30000n,
      mapping: { baseGroup: 1000n, baseTimestamp: W * 30000n, groupMultiplier: 60060n, objectMultiplier: 1001n },
    });
  });

  it('is undefined for a track without timestamp properties', () => {
    expect(parseTimestampTrack(undefined)).toBeUndefined();
    expect(parseTimestampTrack(new Map([[0x08n, [1000000n]]]))).toBeUndefined();
  });

  it.each([
    ['a mapping without TIMESCALE', [[P.timestampMapping, [vi64s(0n, 0n, 1n, 0n)]]], 'TIMESCALE missing or 0'],
    ['TIMESCALE 0', [[P.timescale, [0n]]], 'TIMESCALE missing or 0'],
    ['CLOCK_ID without TIMESCALE', [[P.clockId, [0n]]], 'TIMESCALE missing or 0'],
    ['three mapping integers', [[P.timescale, [1000n]], [P.timestampMapping, [vi64s(0n, 0n, 1n)]]],
      'TIMESTAMP_MAPPING is not four integers'],
    ['five mapping integers', [[P.timescale, [1000n]], [P.timestampMapping, [vi64s(0n, 0n, 1n, 0n, 0n)]]],
      'TIMESTAMP_MAPPING is not four integers'],
    ['a truncated mapping integer', [[P.timescale, [1000n]], [P.timestampMapping, [new Uint8Array([0, 0, 0, 0x80])]]],
      'TIMESTAMP_MAPPING is not four integers'],
    ['TIMESCALE twice', [[P.timescale, [1000n, 1000n]]], 'TIMESCALE appears more than once'],
    ['OBJECT_TIMESTAMP as a Track Property', [[P.timescale, [1000n]], [P.objectTimestamp, [0n]]],
      'OBJECT_TIMESTAMP as a Track Property'],
    ['TIMESTAMP_ORIGIN without CLOCK_ID', [[P.timescale, [1000n]], [P.timestampOrigin, [5n]]],
      'TIMESTAMP_ORIGIN without CLOCK_ID'],
  ] as [string, [bigint, unknown[]][], string][])('treats %s as malformed', (_, props, error) => {
    expect(parseTimestampTrack(new Map(props))).toEqual({ error });
  });
});

describe('propertyCaptureUs', () => {
  it('maps an on-schedule object with no correction (NTSC multipliers)', () => {
    // 2 groups × 60060 + 5 × 1001 = 125125 ticks = 4.170833… s
    expect(propertyCaptureUs(ntsc(), 1002n, 5n)).toEqual({ value: W_US + 4_170_833n });
  });

  it('applies a negative zig-zag correction', () => {
    // 125125 − 1001 = 124124 ticks = 4.137466… s
    expect(propertyCaptureUs(ntsc(), 1002n, 5n, zigzagEncode(-1001n))).toEqual({ value: W_US + 4_137_466n });
  });

  it('maps groups before the base group', () => {
    expect(propertyCaptureUs(ntsc(), 998n, 0n)).toEqual({ value: W_US - 4_004_000n });
  });

  it.each([[0n, 1000n], [1n, 999n], [2n, 1001n], [3n, 998n]])('decodes zig-zag %s as %s ticks', (u, us) => {
    const t = track([[P.timescale, [1_000_000n]], [P.timestampMapping, [vi64s(0n, 1000n, 0n, 0n)]]]);
    expect(propertyCaptureUs(t, 0n, 0n, u)).toEqual({ value: us });
  });

  it('keeps BigInt precision at epoch times beyond 2^53 ticks', () => {
    // (W × 90000 + 1) × 10^6 exceeds 2^53; a float product would round.
    const t = track([[P.timescale, [90000n]], [P.timestampMapping, [vi64s(0n, W * 90000n + 1n, 0n, 0n)]]]);
    const r = propertyCaptureUs(t, 0n, 0n);
    expect(r).toEqual({ value: W_US + 11n });
    expect(Number(r.value)).toBe(Number(W_US) + 11);
  });

  it('reads OBJECT_TIMESTAMP as the timestamp on a track without a mapping', () => {
    const t = track([[P.timescale, [1000n]]]);
    expect(propertyCaptureUs(t, 3n, 4n, W * 1000n)).toEqual({ value: W_US });
    expect(propertyCaptureUs(t, 3n, 4n)).toEqual({});
  });

  it('adds TIMESTAMP_ORIGIN on CLOCK_ID 0 and yields nothing for another clock', () => {
    const wall = track([[P.timescale, [1_000_000n]], [P.clockId, [0n]], [P.timestampOrigin, [W_US]],
      [P.timestampMapping, [vi64s(0n, 0n, 1n, 0n)]]]);
    expect(propertyCaptureUs(wall, 5n, 0n)).toEqual({ value: W_US + 5n });
    const shared = track([[P.timescale, [48000n]], [P.clockId, [0x1a3f5c9e07b2d461n]],
      [P.timestampMapping, [vi64s(0n, 0n, 960n, 0n)]]]);
    expect(propertyCaptureUs(shared, 5n, 0n)).toEqual({});
  });

  it('treats a timestamp outside 0..2^64-1 as malformed', () => {
    const t = track([[P.timescale, [1000n]], [P.timestampMapping, [vi64s(0n, 0n, 1n, 0n)]]]);
    expect(propertyCaptureUs(t, 0n, 0n, zigzagEncode(-1n)).error).toMatch(/outside/);
    const top = track([[P.timescale, [1000n]], [P.timestampMapping, [vi64s(0n, (1n << 64n) - 1n, 0n, 0n)]]]);
    expect(propertyCaptureUs(top, 0n, 0n, zigzagEncode(1n)).error).toMatch(/outside/);
  });
});

describe('readObjectTimestamp', () => {
  it('reads OBJECT_TIMESTAMP among other properties', () => {
    const block = encodePropertyBlock([{ id: 0x10n, value: W_US }, { id: P.objectTimestamp, value: 7n }], D18);
    expect(readObjectTimestamp(block, D18)).toEqual({ value: 7n });
    expect(readObjectTimestamp(undefined, D18)).toEqual({});
  });

  it('treats a repeated OBJECT_TIMESTAMP or a Track Property on an object as malformed', () => {
    const twice = encodePropertyBlock([{ id: P.objectTimestamp, value: 1n }, { id: P.objectTimestamp, value: 2n }], D18);
    expect(readObjectTimestamp(twice, D18)).toEqual({ error: 'OBJECT_TIMESTAMP appears more than once' });
    const scoped = encodePropertyBlock([{ id: P.timescale, value: 1000n }], D18);
    expect(readObjectTimestamp(scoped, D18)).toEqual({ error: 'TIMESCALE as an Object Property' });
  });

  it('flags timestamp properties on a track that declared none', () => {
    expect(undeclaredTimestampError(new Map([[P.objectTimestamp, 5n]]))).toBe('OBJECT_TIMESTAMP without TIMESCALE');
    expect(undeclaredTimestampError(new Map([[P.timestampMapping, new Uint8Array()]])))
      .toBe('TIMESTAMP_MAPPING as an Object Property');
    expect(undeclaredTimestampError(new Map([[0x3800n, 1n]]))).toBeUndefined();
    expect(undeclaredTimestampError(undefined)).toBeUndefined();
  });
});

function box(type: string, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(8 + body.length);
  new DataView(out.buffer).setUint32(0, out.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(body, 8);
  return out;
}

/** prft body: version/flags, reference_track_ID, NTP 64, media_time. */
function prft(version: 0 | 1, ntpSec: bigint, ntpFrac: number): Uint8Array {
  const body = new Uint8Array(version === 1 ? 24 : 20);
  const v = new DataView(body.buffer);
  v.setUint8(0, version);
  v.setUint32(4, 1);
  v.setUint32(8, Number(ntpSec));
  v.setUint32(12, ntpFrac);
  return box('prft', body);
}

const concat = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let pos = 0;
  for (const p of parts) { out.set(p, pos); pos += p.length; }
  return out;
};

const NTP_W = W + 2_208_988_800n;

describe('readPrftUs', () => {
  it('reads the NTP time of a top-level prft before the moof (v1 and v0)', () => {
    const moof = box('moof', new Uint8Array(16));
    expect(readPrftUs(concat(box('styp', new Uint8Array(4)), prft(1, NTP_W, 0x8000_0000), moof)))
      .toBe(W_US + 500_000n);
    expect(readPrftUs(concat(prft(0, NTP_W, 0), moof))).toBe(W_US);
  });

  it('is undefined without a prft, or for a truncated one', () => {
    expect(readPrftUs(concat(box('moof', new Uint8Array(16)), box('mdat', new Uint8Array(4))))).toBeUndefined();
    expect(readPrftUs(box('prft', new Uint8Array(8)))).toBeUndefined();
    expect(readPrftUs(new Uint8Array([0, 0, 0, 4, 1]))).toBeUndefined();
  });
});

describe('pickCaptureTime', () => {
  it('prefers the timestamp properties, then LOC, then prft', () => {
    expect(pickCaptureTime({ property: 1, loc: 2, prft: 3 })).toEqual({ source: 'property', us: 1 });
    expect(pickCaptureTime({ loc: 2, prft: 3 })).toEqual({ source: 'loc', us: 2 });
    expect(pickCaptureTime({ prft: 3 })).toEqual({ source: 'prft', us: 3 });
    expect(pickCaptureTime({})).toBeUndefined();
    expect(pickCaptureTime(undefined)).toBeUndefined();
  });
});

function dataObject(alias: bigint, groupId: bigint, objectId: bigint, extensions?: Uint8Array,
  payload: Uint8Array = new Uint8Array()): MoqtObject {
  return {
    kind: 'data', trackAlias: alias, groupId, subgroupId: 0n, objectId, publisherPriority: undefined,
    ...(extensions ? { extensions } : {}), payload,
  };
}

describe('SubscriptionManager.captureTimeFields', () => {
  const routed = (sm: SubscriptionManager, obj: MoqtObject) => {
    const ext = obj.kind === 'data' ? obj.extensions : undefined;
    return sm.captureTimeFields(obj, parseLocHeaders(ext, { wireProfile: D18 }));
  };

  it('reports the mapped time beside the LOC Timestamp', () => {
    const sm = new SubscriptionManager();
    sm.draftVersion = 18;
    sm.registerTrack(7n, 'video', 'video', 'loc', { timestamps: ntsc() });
    const ext = encodePropertyBlock([{ id: 0x10n, value: W_US + 4_137_000n },
      { id: P.objectTimestamp, value: zigzagEncode(-1001n) }], D18);
    expect(routed(sm, dataObject(7n, 1002n, 5n, ext))).toEqual({
      captureTimes: { property: Number(W_US + 4_137_466n), loc: Number(W_US + 4_137_000n) },
    });
  });

  it('a malformed object disables the track\'s properties until it is registered again', () => {
    const sm = new SubscriptionManager();
    sm.draftVersion = 18;
    sm.registerTrack(7n, 'video', 'video', 'loc', { timestamps: ntsc() });
    const twice = encodePropertyBlock([{ id: P.objectTimestamp, value: 1n }, { id: P.objectTimestamp, value: 2n }], D18);
    const error = 'OBJECT_TIMESTAMP appears more than once';
    expect(routed(sm, dataObject(7n, 1000n, 0n, twice))).toEqual({ timingError: error });
    expect(routed(sm, dataObject(7n, 1000n, 1n))).toEqual({ timingError: error });
    sm.registerTrack(7n, 'video', 'video', 'loc', { timestamps: ntsc() });
    expect(routed(sm, dataObject(7n, 1000n, 0n))).toEqual({ captureTimes: { property: Number(W_US) } });
  });

  it('reports a malformed declaration and still gives the LOC Timestamp', () => {
    const sm = new SubscriptionManager();
    sm.draftVersion = 18;
    sm.registerTrack(7n, 'audio', 'audio', 'loc', { timestamps: { error: 'TIMESCALE missing or 0' } });
    const ext = encodePropertyBlock([{ id: 0x10n, value: W_US }], D18);
    expect(routed(sm, dataObject(7n, 1n, 0n, ext)))
      .toEqual({ captureTimes: { loc: Number(W_US) }, timingError: 'TIMESCALE missing or 0' });
  });

  it('flags OBJECT_TIMESTAMP on a track without TIMESCALE', () => {
    const sm = new SubscriptionManager();
    sm.draftVersion = 18;
    sm.registerTrack(7n, 'video', 'video', 'loc');
    const ext = encodePropertyBlock([{ id: P.objectTimestamp, value: 5n }], D18);
    expect(routed(sm, dataObject(7n, 1n, 0n, ext))).toEqual({ timingError: 'OBJECT_TIMESTAMP without TIMESCALE' });
  });

  it('reads prft from the first object of a CMAF group only', () => {
    const sm = new SubscriptionManager();
    sm.registerTrack(8n, 'video', 'video', 'cmaf');
    const payload = concat(prft(1, NTP_W, 0), box('moof', new Uint8Array(16)));
    expect(routed(sm, dataObject(8n, 3n, 0n, undefined, payload))).toEqual({ captureTimes: { prft: Number(W_US) } });
    expect(routed(sm, dataObject(8n, 3n, 1n, undefined, payload))).toEqual({});
  });

  it('adds nothing for a track without timing metadata', () => {
    const sm = new SubscriptionManager();
    sm.registerTrack(9n, 'video', 'video', 'loc');
    expect(routed(sm, dataObject(9n, 1n, 0n))).toEqual({});
  });
});

describe('SUBSCRIBE_OK timestamp Track Properties', () => {
  it('ride the track registration', () => {
    const registerTrack = vi.fn();
    const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const ctx: ControlMessageContext = {
      adapter: { unsubscribe: vi.fn() } as any,
      activeSubscriptions: new Map([[5n, { trackName: 'video', trackAlias: null }]]),
      pendingMediaSubs: new Map([[5n, { trackName: 'video', mediaType: 'video', packaging: 'loc' }]]),
      removeSubscription: (requestId) => removeSubscription(requestId, ctx),
      pendingTrackStatuses: new Map(),
      catalogRequestId: null,
      catalogTrackAlias: null,
      subscriptionManager: { registerTrack, unregisterTrack: vi.fn(), getMediaType: () => undefined } as any,
      log,
      emitEvent: vi.fn(),
      setCatalogTrackAlias: vi.fn(),
      clearCatalogState: vi.fn(),
      onGoaway: vi.fn(),
    };
    const msg = {
      type: 'SUBSCRIBE_OK', requestId: 5n, trackAlias: 99n,
      expires: 0n, groupOrder: 0x1n, contentExists: false,
      trackProperties: new Map<bigint, unknown[]>([
        [P.timescale, [30000n]],
        [P.timestampMapping, [vi64s(1000n, W * 30000n, 60060n, 1001n)]],
      ]),
    } as unknown as ControlMessage;
    handleControlMessage(msg, ctx);
    expect(registerTrack).toHaveBeenCalledWith(99n, 'video', 'video', 'loc', { timestamps: ntsc() });
  });
});
