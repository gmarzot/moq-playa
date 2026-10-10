/**
 * CMAF muxing for a live WebCodecs source: an init segment per track
 * (ftyp + moov with mvex) and one CMAF chunk (moof + mdat) per encoded frame.
 * Repackaging only — the encoded bitstream is carried unchanged.
 *
 * Video: H.264 in the AVC layout WebCodecs emits by default (length-prefixed
 * NAL units, avcC as the decoder description), or AV1 with its av1C.
 * Audio: Opus with a dOps box.
 *
 * @see draft-ietf-moq-cmsf-01 §3 (CMAF packaging)
 * @see ISO/IEC 14496-12 (ISO BMFF), ISO/IEC 14496-15 (avcC), AV1-ISOBMFF, Opus-in-ISOBMFF
 * @module
 */

/** A track timescale in microseconds, so decode times equal capture timestamps. */
export const MICROSECOND_TIMESCALE = 1_000_000;

const enc = new TextEncoder();

function concat(parts: Uint8Array[]): Uint8Array {
  let length = 0;
  for (const p of parts) length += p.byteLength;
  const out = new Uint8Array(length);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.byteLength;
  }
  return out;
}

function u8(v: number): Uint8Array { return new Uint8Array([v & 0xff]); }
function u16(v: number): Uint8Array { return new Uint8Array([(v >>> 8) & 0xff, v & 0xff]); }
function u32(v: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, v >>> 0);
  return b;
}
function u64(v: bigint): Uint8Array {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, v);
  return b;
}
function zeros(n: number): Uint8Array { return new Uint8Array(n); }
function fourcc(s: string): Uint8Array { return enc.encode(s); }

function box(type: string, ...children: Uint8Array[]): Uint8Array {
  const body = concat(children);
  return concat([u32(8 + body.byteLength), fourcc(type), body]);
}

function fullBox(type: string, version: number, flags: number, ...children: Uint8Array[]): Uint8Array {
  return box(type, u8(version), u8(flags >>> 16), u16(flags & 0xffff), ...children);
}

/** Unity transformation matrix (tkhd, mvhd). */
const MATRIX = concat([
  u32(0x00010000), u32(0), u32(0),
  u32(0), u32(0x00010000), u32(0),
  u32(0), u32(0), u32(0x40000000),
]);

/** Sample flags: a sync sample depending on nothing / a non-sync sample that depends on others. */
const SYNC_SAMPLE_FLAGS = 0x02000000;
const NON_SYNC_SAMPLE_FLAGS = 0x01010000;

export interface CmafVideoTrack {
  readonly trackId: number;
  readonly timescale: number;
  /** WebCodecs codec string; `avc1.*` or `av01.*`. */
  readonly codec: string;
  readonly width: number;
  readonly height: number;
  /** The encoder's decoder description: avcC for H.264, av1C for AV1. */
  readonly description: Uint8Array;
}

export interface CmafAudioTrack {
  readonly trackId: number;
  readonly timescale: number;
  readonly sampleRate: number;
  readonly channels: number;
  /** Opus pre-skip in 48 kHz samples. Default 0. */
  readonly preSkip?: number;
}

function ftyp(): Uint8Array {
  return box('ftyp', fourcc('iso6'), u32(0), fourcc('iso6'), fourcc('cmfc'), fourcc('mp41'));
}

function mvhd(nextTrackId: number): Uint8Array {
  return fullBox('mvhd', 0, 0,
    u32(0), u32(0), u32(1000), u32(0),   // creation, modification, timescale, duration
    u32(0x00010000), u16(0x0100), zeros(10), // rate, volume, reserved
    MATRIX, zeros(24), u32(nextTrackId));
}

function tkhd(trackId: number, audio: boolean, width: number, height: number): Uint8Array {
  return fullBox('tkhd', 0, 0x000003,     // enabled, in movie
    u32(0), u32(0), u32(trackId), u32(0), u32(0), // creation, modification, id, reserved, duration
    zeros(8), u16(0), u16(0), u16(audio ? 0x0100 : 0), u16(0), // layer, group, volume
    MATRIX, u32(width << 16), u32(height << 16));
}

function mdhd(timescale: number): Uint8Array {
  // Language 'und', packed ISO-639-2/T.
  return fullBox('mdhd', 0, 0, u32(0), u32(0), u32(timescale), u32(0), u16(0x55c4), u16(0));
}

function hdlr(handler: 'vide' | 'soun'): Uint8Array {
  const name = handler === 'vide' ? 'VideoHandler' : 'SoundHandler';
  return fullBox('hdlr', 0, 0, u32(0), fourcc(handler), zeros(12), enc.encode(name), u8(0));
}

function emptySampleTables(sampleEntry: Uint8Array): Uint8Array {
  return box('stbl',
    fullBox('stsd', 0, 0, u32(1), sampleEntry),
    fullBox('stts', 0, 0, u32(0)),
    fullBox('stsc', 0, 0, u32(0)),
    fullBox('stsz', 0, 0, u32(0), u32(0)),
    fullBox('stco', 0, 0, u32(0)));
}

function dinf(): Uint8Array {
  return box('dinf', fullBox('dref', 0, 0, u32(1), fullBox('url ', 0, 0x000001)));
}

function trex(trackId: number): Uint8Array {
  return fullBox('trex', 0, 0, u32(trackId), u32(1), u32(0), u32(0), u32(0));
}

function initSegment(trackId: number, trak: Uint8Array): Uint8Array {
  return concat([ftyp(), box('moov', mvhd(trackId + 1), trak, box('mvex', trex(trackId)))]);
}

/** Init segment for a video track. Throws for a codec it cannot describe. */
export function buildVideoInit(t: CmafVideoTrack): Uint8Array {
  let entryType: string;
  let configType: string;
  if (t.codec.startsWith('avc1')) {
    entryType = 'avc1';
    configType = 'avcC';
  } else if (t.codec.startsWith('av01')) {
    entryType = 'av01';
    configType = 'av1C';
  } else {
    throw new Error(`CMAF packaging does not support video codec ${t.codec}`);
  }
  const sampleEntry = box(entryType,
    zeros(6), u16(1),                       // reserved, data_reference_index
    u16(0), u16(0), zeros(12),              // pre_defined, reserved, pre_defined
    u16(t.width), u16(t.height),
    u32(0x00480000), u32(0x00480000),       // 72 dpi
    u32(0), u16(1), zeros(32),              // reserved, frame_count, compressorname
    u16(0x0018), u16(0xffff),               // depth, pre_defined
    box(configType, t.description));
  const trak = box('trak',
    tkhd(t.trackId, false, t.width, t.height),
    box('mdia', mdhd(t.timescale), hdlr('vide'),
      box('minf', fullBox('vmhd', 0, 0x000001, u16(0), zeros(6)), dinf(), emptySampleTables(sampleEntry))));
  return initSegment(t.trackId, trak);
}

/** Init segment for an Opus audio track. */
export function buildAudioInit(t: CmafAudioTrack): Uint8Array {
  const dOps = box('dOps',
    u8(0), u8(t.channels), u16(t.preSkip ?? 0), u32(t.sampleRate), u16(0), u8(0));
  const sampleEntry = box('Opus',
    zeros(6), u16(1),                       // reserved, data_reference_index
    zeros(8), u16(t.channels), u16(16),     // reserved, channelcount, samplesize
    u16(0), u16(0), u32(48000 * 65536),     // pre_defined, reserved, samplerate (Opus: 48 kHz)
    dOps);
  const trak = box('trak',
    tkhd(t.trackId, true, 0, 0),
    box('mdia', mdhd(t.timescale), hdlr('soun'),
      box('minf', fullBox('smhd', 0, 0, u16(0), u16(0)), dinf(), emptySampleTables(sampleEntry))));
  return initSegment(t.trackId, trak);
}

export interface CmafChunkFields {
  readonly trackId: number;
  /** mfhd sequence number; increments per chunk within a track. */
  readonly sequence: number;
  /** Decode time of the sample, in the track timescale. */
  readonly baseDecodeTime: bigint;
  /** Sample duration, in the track timescale. */
  readonly duration: number;
  /** A sync sample (keyframe); every audio frame is one. */
  readonly keyframe: boolean;
  readonly data: Uint8Array;
}

/** One CMAF chunk (moof + mdat) carrying a single sample. */
export function buildChunk(c: CmafChunkFields): Uint8Array {
  // moof 100 = 8 + mfhd 16 + traf 76 (8 + tfhd 16 + tfdt 20 + trun 32).
  const MOOF_SIZE = 100;
  const moof = box('moof',
    fullBox('mfhd', 0, 0, u32(c.sequence)),
    box('traf',
      fullBox('tfhd', 0, 0x020000, u32(c.trackId)),            // default-base-is-moof
      fullBox('tfdt', 1, 0, u64(c.baseDecodeTime)),
      fullBox('trun', 0, 0x000701,                             // data offset; duration, size, flags
        u32(1), u32(MOOF_SIZE + 8),
        u32(c.duration), u32(c.data.byteLength),
        u32(c.keyframe ? SYNC_SAMPLE_FLAGS : NON_SYNC_SAMPLE_FLAGS))));
  if (moof.byteLength !== MOOF_SIZE) throw new Error(`moof is ${moof.byteLength} bytes, expected ${MOOF_SIZE}`);
  return concat([moof, box('mdat', c.data)]);
}

/** Opus pre-skip from an OpusHead decoder description, if one was given. */
export function opusPreSkip(description: Uint8Array | undefined): number | undefined {
  if (!description || description.byteLength < 12) return undefined;
  if (new TextDecoder().decode(description.subarray(0, 8)) !== 'OpusHead') return undefined;
  return description[10]! | (description[11]! << 8);
}
