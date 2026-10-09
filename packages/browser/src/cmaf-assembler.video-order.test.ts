/**
 * CmafAssembler video decode order: a group's late tail is placed before the
 * next group's keyframe, a skip inside a group is not held, video that starts
 * before what was emitted is dropped rather than appended, and in-order video
 * that ends early is kept.
 */
import { describe, it, expect, vi } from 'vitest';
import { CmafAssembler } from './cmaf-assembler.js';
import { readBaseMediaDecodeTime, writeU32 } from './mp4-box.js';

// Helpers as in cmaf-assembler.test.ts.

/** Build a minimal moof box with tfdt carrying the given baseMediaDecodeTime. */
function buildMoof(baseMediaDecodeTime: number, sequenceNumber = 1, sampleDuration?: number): Uint8Array {
  // mfhd: size(4) + type(4) + version+flags(4) + sequence_number(4) = 16 bytes
  const mfhd = new Uint8Array(16);
  writeU32(mfhd, 0, 16);
  mfhd[4] = 0x6d; mfhd[5] = 0x66; mfhd[6] = 0x68; mfhd[7] = 0x64; // 'mfhd'
  writeU32(mfhd, 12, sequenceNumber);

  // tfhd: size(4) + type(4) + version+flags(4) + track_id(4) = 16 bytes
  const tfhd = new Uint8Array(sampleDuration === undefined ? 16 : 20);
  writeU32(tfhd, 0, tfhd.byteLength);
  tfhd[4] = 0x74; tfhd[5] = 0x66; tfhd[6] = 0x68; tfhd[7] = 0x64; // 'tfhd'
  if (sampleDuration !== undefined) {
    tfhd[11] = 0x08; // default_sample_duration_present
    writeU32(tfhd, 16, sampleDuration);
  }
  writeU32(tfhd, 12, 1); // track_id = 1

  // tfdt version 0: size(4) + type(4) + version+flags(4) + baseMediaDecodeTime(4) = 16 bytes
  const tfdt = new Uint8Array(16);
  writeU32(tfdt, 0, 16);
  tfdt[4] = 0x74; tfdt[5] = 0x66; tfdt[6] = 0x64; tfdt[7] = 0x74; // 'tfdt'
  tfdt[8] = 0; // version 0
  writeU32(tfdt, 12, baseMediaDecodeTime);

  // trun: size(4) + type(4) + version+flags(4) + sample_count(4) = 16 bytes
  const trun = new Uint8Array(16);
  writeU32(trun, 0, 16);
  trun[4] = 0x74; trun[5] = 0x72; trun[6] = 0x75; trun[7] = 0x6e; // 'trun'
  writeU32(trun, 12, 1); // 1 sample

  // traf = tfhd + tfdt + trun
  const trafContent = new Uint8Array(tfhd.byteLength + tfdt.byteLength + trun.byteLength);
  trafContent.set(tfhd, 0);
  trafContent.set(tfdt, tfhd.byteLength);
  trafContent.set(trun, tfhd.byteLength + tfdt.byteLength);
  const traf = new Uint8Array(8 + trafContent.byteLength);
  writeU32(traf, 0, 8 + trafContent.byteLength);
  traf[4] = 0x74; traf[5] = 0x72; traf[6] = 0x61; traf[7] = 0x66; // 'traf'
  traf.set(trafContent, 8);

  // moof = mfhd + traf
  const moofContent = new Uint8Array(mfhd.byteLength + traf.byteLength);
  moofContent.set(mfhd, 0);
  moofContent.set(traf, mfhd.byteLength);
  const moof = new Uint8Array(8 + moofContent.byteLength);
  writeU32(moof, 0, 8 + moofContent.byteLength);
  moof[4] = 0x6d; moof[5] = 0x6f; moof[6] = 0x6f; moof[7] = 0x66; // 'moof'
  moof.set(moofContent, 8);

  return moof;
}

/** Build an arbitrary MP4 box with the given 4-char type and body. */
function buildBox(type: string, body: Uint8Array): Uint8Array {
  const box = new Uint8Array(8 + body.byteLength);
  writeU32(box, 0, 8 + body.byteLength);
  box[4] = type.charCodeAt(0); box[5] = type.charCodeAt(1);
  box[6] = type.charCodeAt(2); box[7] = type.charCodeAt(3);
  box.set(body, 8);
  return box;
}

/** Concatenate multiple Uint8Arrays. */
function concat(...arrays: Uint8Array[]): Uint8Array {
  const total = arrays.reduce((sum, a) => sum + a.byteLength, 0);
  const out = new Uint8Array(total);
  let pos = 0;
  for (const a of arrays) { out.set(a, pos); pos += a.byteLength; }
  return out;
}

/** Build a minimal mdat box with the given payload. */
function buildMdat(payload: Uint8Array): Uint8Array {
  const mdat = new Uint8Array(8 + payload.byteLength);
  writeU32(mdat, 0, 8 + payload.byteLength);
  mdat[4] = 0x6d; mdat[5] = 0x64; mdat[6] = 0x61; mdat[7] = 0x74; // 'mdat'
  mdat.set(payload, 8);
  return mdat;
}

/** Build a version 1 (64-bit) tfdt moof. */

const TS = 24_000;
const FRAME = 1_000;  // 24 fps
const FRAME_MS = (FRAME * 1000) / TS;

function videoInit(): Uint8Array {
  const body = new Uint8Array(20);
  new DataView(body.buffer).setUint32(8, TS);
  const mdhd = buildBox('mdhd', concat(new Uint8Array(4), body));
  return buildBox('moov', buildBox('trak', buildBox('mdia', mdhd)));
}

function setup(videoAheadMs?: () => number | null) {
  const onSegment = vi.fn();
  const assembler = new CmafAssembler({ onSegment, ...(videoAheadMs ? { videoAheadMs } : {}) });
  assembler.setInitSegment('video', videoInit());
  /** Video frame n at decode time n × FRAME, in `group`. */
  const push = (n: number, group: number) => assembler.push('video', 'video0', BigInt(group),
    concat(buildMoof(n * FRAME, n + 1, FRAME), buildMdat(new Uint8Array([n]))));
  const emitted = () => onSegment.mock.calls.map(
    (c) => Number(readBaseMediaDecodeTime(c[1] as Uint8Array)!) / FRAME);
  return { assembler, push, emitted };
}

describe('CmafAssembler — video decode order', () => {
  it("places a group's late tail before the next group's keyframe", () => {
    const { assembler, push, emitted } = setup();
    push(0, 0); push(1, 0);
    push(3, 1);              // the next group's keyframe, ahead of frame 2
    push(4, 1);
    expect(emitted()).toEqual([0, 1]);
    push(2, 0);              // the tail arrives
    expect(emitted()).toEqual([0, 1, 2, 3, 4]);
    expect(assembler.videoOrderStats).toMatchObject({ restored: 1, missing: 0, late: 0 });
  });

  it('does not hold a skipped frame inside a group', () => {
    vi.useFakeTimers();
    try {
      const { push, emitted } = setup(() => 200);
      push(0, 0); push(1, 0); push(3, 0);
      expect(emitted()).toEqual([0, 1, 3]);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('releases the next group when the tail never comes, and drops it if it does later', () => {
    vi.useFakeTimers();
    try {
      const { assembler, push, emitted } = setup(() => 200);
      push(0, 0); push(1, 0);
      push(3, 1);
      vi.advanceTimersByTime(200 - 150 - 1);   // held until 150 ms remain buffered
      expect(emitted()).toEqual([0, 1]);
      vi.advanceTimersByTime(2);
      expect(emitted()).toEqual([0, 1, 3]);
      push(2, 0);            // starts before frame 3: appending it would cost the group
      expect(emitted()).toEqual([0, 1, 3]);
      expect(assembler.videoOrderStats).toMatchObject({ restored: 0, missing: 1, late: 1 });
    } finally {
      vi.useRealTimers();
    }
  });

  it('appends an in-order frame that ends inside a longer previous frame', () => {
    const { assembler, emitted } = setup();
    const pushSpan = (start: number, duration: number, seq: number) => assembler.push('video', 'video0', 0n,
      concat(buildMoof(start, seq, duration), buildMdat(new Uint8Array([seq]))));
    pushSpan(0, FRAME, 1);
    pushSpan(FRAME, 3 * FRAME, 2);   // after a capture hiccup: a long duration
    pushSpan(2 * FRAME, FRAME, 3);   // on time, ends inside the previous frame
    pushSpan(3 * FRAME, FRAME, 4);
    expect(emitted()).toEqual([0, 1, 2, 3]);
    expect(assembler.videoOrderStats).toMatchObject({ restored: 0, missing: 0, late: 0 });
  });
});
