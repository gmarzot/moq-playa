/**
 * Random-access detection for CMAF chunks.
 *
 * A track switch may only splice the new track in at a sync sample. Object ID
 * 0 is the usual group-start signal, but a relay that joins a subscriber
 * mid-group can deliver a delta frame first, so the switch reads the sample
 * flags the chunk itself declares.
 *
 * @see ISO/IEC 14496-12 §8.8.3.1 (sample_flags), §8.8.7 (tfhd), §8.8.8 (trun)
 * @module
 */

/** sample_flags bit sample_is_non_sync_sample. */
const SAMPLE_IS_NON_SYNC = 0x00010000;

const TFHD_BASE_DATA_OFFSET = 0x000001;
const TFHD_SAMPLE_DESCRIPTION_INDEX = 0x000002;
const TFHD_DEFAULT_SAMPLE_DURATION = 0x000008;
const TFHD_DEFAULT_SAMPLE_SIZE = 0x000010;
const TFHD_DEFAULT_SAMPLE_FLAGS = 0x000020;

const TRUN_DATA_OFFSET = 0x000001;
const TRUN_FIRST_SAMPLE_FLAGS = 0x000004;
const TRUN_SAMPLE_DURATION = 0x000100;
const TRUN_SAMPLE_SIZE = 0x000200;
const TRUN_SAMPLE_FLAGS = 0x000400;

/**
 * Whether the first sample of a CMAF chunk (`[styp] moof [mdat]`) is a sync
 * sample. Flags come from trun (first_sample_flags or per-sample flags), else
 * the tfhd default.
 *
 * Returns null when it cannot tell: no moof (e.g. an mdat-only object) or no
 * flags for the first sample in the chunk (they would live in the init's trex).
 */
export function cmafChunkStartsWithSync(chunk: Uint8Array): boolean | null {
  const view = new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  const moof = findBox(chunk, view, 0, chunk.byteLength, 'moof');
  if (!moof) return null;
  const traf = findBox(chunk, view, moof.start + 8, moof.end, 'traf');
  if (!traf) return null;
  const tfhd = findBox(chunk, view, traf.start + 8, traf.end, 'tfhd');
  const trun = findBox(chunk, view, traf.start + 8, traf.end, 'trun');
  if (!trun || trun.end - trun.start < 16) return null;

  const trunFlags = view.getUint32(trun.start + 8) & 0xffffff;
  if (view.getUint32(trun.start + 12) === 0) return null;
  let pos = trun.start + 16;
  if (trunFlags & TRUN_DATA_OFFSET) pos += 4;
  if (trunFlags & TRUN_FIRST_SAMPLE_FLAGS) {
    return pos + 4 <= trun.end ? isSync(view.getUint32(pos)) : null;
  }
  if (trunFlags & TRUN_SAMPLE_FLAGS) {
    if (trunFlags & TRUN_SAMPLE_DURATION) pos += 4;
    if (trunFlags & TRUN_SAMPLE_SIZE) pos += 4;
    return pos + 4 <= trun.end ? isSync(view.getUint32(pos)) : null;
  }

  if (!tfhd || tfhd.end - tfhd.start < 16) return null;
  const tfhdFlags = view.getUint32(tfhd.start + 8) & 0xffffff;
  if (!(tfhdFlags & TFHD_DEFAULT_SAMPLE_FLAGS)) return null;
  let p = tfhd.start + 16; // after header, version/flags and track_ID
  if (tfhdFlags & TFHD_BASE_DATA_OFFSET) p += 8;
  if (tfhdFlags & TFHD_SAMPLE_DESCRIPTION_INDEX) p += 4;
  if (tfhdFlags & TFHD_DEFAULT_SAMPLE_DURATION) p += 4;
  if (tfhdFlags & TFHD_DEFAULT_SAMPLE_SIZE) p += 4;
  return p + 4 <= tfhd.end ? isSync(view.getUint32(p)) : null;
}

function isSync(flags: number): boolean {
  return (flags & SAMPLE_IS_NON_SYNC) === 0;
}

/** First child box of `type` within [start, end), or undefined. 32-bit sizes only. */
function findBox(
  buf: Uint8Array, view: DataView, start: number, end: number, type: string,
): { start: number; end: number } | undefined {
  let pos = start;
  while (pos + 8 <= end) {
    const size = view.getUint32(pos);
    if (size < 8 || pos + size > end) return undefined;
    if (buf[pos + 4] === type.charCodeAt(0) && buf[pos + 5] === type.charCodeAt(1)
      && buf[pos + 6] === type.charCodeAt(2) && buf[pos + 7] === type.charCodeAt(3)) {
      return { start: pos, end: pos + size };
    }
    pos += size;
  }
  return undefined;
}
