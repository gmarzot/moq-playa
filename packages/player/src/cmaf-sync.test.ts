import { describe, it, expect } from 'vitest';
import { cmafChunkStartsWithSync } from './cmaf-sync.js';

const SYNC = 0x02000000; // sample_depends_on = 2 (I-frame), sync
const NON_SYNC = 0x01010000; // sample_depends_on = 1, sample_is_non_sync_sample

function box(type: string, ...parts: number[][]): number[] {
  const body = parts.flat();
  const size = 8 + body.length;
  return [size >>> 24, (size >>> 16) & 0xff, (size >>> 8) & 0xff, size & 0xff,
    ...[...type].map(c => c.charCodeAt(0)), ...body];
}
const u32 = (v: number): number[] => [v >>> 24, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff];
const fullBox = (type: string, flags: number, ...fields: number[][]): number[] =>
  box(type, u32(flags & 0xffffff), ...fields);

/** moof+mdat with one sample, flags placed where `where` says. */
function chunk(where: 'first' | 'per-sample' | 'tfhd' | 'none', flags: number): Uint8Array {
  const tfhdFlags = where === 'tfhd' ? 0x020020 : 0x020000; // default-base-is-moof (+ default flags)
  const tfhd = fullBox('tfhd', tfhdFlags, u32(1), ...(where === 'tfhd' ? [u32(flags)] : []));
  const trun = where === 'first'
    ? fullBox('trun', 0x000205, u32(1), u32(0), u32(flags), u32(4))
    : where === 'per-sample'
      ? fullBox('trun', 0x000601, u32(1), u32(0), u32(4), u32(flags))
      : fullBox('trun', 0x000201, u32(1), u32(0), u32(4));
  return new Uint8Array([
    ...box('styp', [0x69, 0x73, 0x6f, 0x36]),
    ...box('moof', fullBox('mfhd', 0, u32(1)), box('traf', tfhd, fullBox('tfdt', 0, u32(0)), trun)),
    ...box('mdat', [0, 0, 0, 0]),
  ]);
}

describe('cmafChunkStartsWithSync', () => {
  it('reads trun first_sample_flags', () => {
    expect(cmafChunkStartsWithSync(chunk('first', SYNC))).toBe(true);
    expect(cmafChunkStartsWithSync(chunk('first', NON_SYNC))).toBe(false);
  });

  it('reads per-sample flags', () => {
    expect(cmafChunkStartsWithSync(chunk('per-sample', SYNC))).toBe(true);
    expect(cmafChunkStartsWithSync(chunk('per-sample', NON_SYNC))).toBe(false);
  });

  it('falls back to the tfhd default flags', () => {
    expect(cmafChunkStartsWithSync(chunk('tfhd', SYNC))).toBe(true);
    expect(cmafChunkStartsWithSync(chunk('tfhd', NON_SYNC))).toBe(false);
  });

  it('cannot tell without flags in the chunk, or without a moof', () => {
    expect(cmafChunkStartsWithSync(chunk('none', 0))).toBeNull();
    expect(cmafChunkStartsWithSync(new Uint8Array(box('mdat', [1, 2, 3, 4])))).toBeNull();
    expect(cmafChunkStartsWithSync(new Uint8Array([0, 0, 0]))).toBeNull();
  });

  it('never reads past a truncated tfhd', () => {
    // trun without sample flags, then an 8-byte tfhd at the very end of the chunk.
    const moof = box('moof', box('traf', fullBox('trun', 0x000001, u32(1), u32(0)), box('tfhd', [])));
    expect(() => cmafChunkStartsWithSync(new Uint8Array(moof))).not.toThrow();
    expect(cmafChunkStartsWithSync(new Uint8Array(moof))).toBeNull();
  });
});
