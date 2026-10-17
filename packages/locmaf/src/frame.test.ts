import { describe, it, expect } from 'vitest';
import { codecDescriptionFromInit, isCmafHeader, sliceFrames, ticksToMicros } from './frame.js';
import { LocmafFormatError } from './errors.js';
import { LocmafTrackDecoder } from './track-decoder.js';
import { LocmafEncoder } from './encoder.js';
import { LocmafGroupState } from './group-state.js';
import { parseLocmafTrackContext } from './track-context.js';
import { serializeLocmafObject } from './serializer.js';
import type { LocmafEffectiveSamples } from './effective.js';
import { NON_SYNC_FLAGS, SYNC_FLAGS, audioInit, buildChunk, buildInit, cencVideoInit, videoInit } from '../test-support/cmaf.js';
import { ascii, concat, fullBox, isoBox, u16, u32, u8 } from '../test-support/bytes.js';

function effective(over: Partial<LocmafEffectiveSamples> = {}): LocmafEffectiveSamples {
    return {
        baseMediaDecodeTime: 90000n,
        sampleDescriptionIndex: 1,
        durations: [3000, 3000, 3000],
        sizes: [4, 2, 3],
        flags: [SYNC_FLAGS, NON_SYNC_FLAGS, NON_SYNC_FLAGS],
        compositionTimeOffsets: [0, 6000, 3000],
        cenc: null,
        ...over,
    };
}

describe('sliceFrames (section 16 frame interface)', () => {
    it('slices the mdat payload into per-sample frames with decode and presentation times', () => {
        const mdat = Uint8Array.of(1, 2, 3, 4, 5, 6, 7, 8, 9);
        const frames = sliceFrames(effective(), mdat);
        expect(frames.map((f) => Array.from(f.data))).toEqual([[1, 2, 3, 4], [5, 6], [7, 8, 9]]);
        expect(frames.map((f) => f.decodeTime)).toEqual([90000n, 93000n, 96000n]);
        expect(frames.map((f) => f.presentationTime)).toEqual([90000n, 99000n, 99000n]);
        expect(frames.map((f) => f.isSync)).toEqual([true, false, false]);
        expect(frames.map((f) => f.duration)).toEqual([3000, 3000, 3000]);
        expect(frames.map((f) => f.index)).toEqual([0, 1, 2]);
        expect(frames.every((f) => f.cenc === null)).toBe(true);
    });

    it('frames are views into the payload, not copies', () => {
        const mdat = Uint8Array.of(1, 2, 3, 4, 5, 6, 7, 8, 9);
        const [first] = sliceFrames(effective(), mdat);
        expect(first!.data.buffer).toBe(mdat.buffer);
    });

    it('an event-only chunk (zero samples, empty mdat) yields no frames', () => {
        expect(sliceFrames(effective({ durations: [], sizes: [], flags: [], compositionTimeOffsets: [] }), new Uint8Array(0))).toEqual([]);
    });

    it('rejects sizes that do not cover exactly the payload', () => {
        expect(() => sliceFrames(effective(), new Uint8Array(8))).toThrow(LocmafFormatError);
        expect(() => sliceFrames(effective(), new Uint8Array(10))).toThrow(LocmafFormatError);
    });

    it('rejects effective vectors that disagree on the sample count', () => {
        expect(() => sliceFrames(effective({ flags: [SYNC_FLAGS] }), new Uint8Array(9))).toThrow(LocmafFormatError);
    });

    it('carries per-frame CENC IVs and subsample maps', () => {
        const e = effective({
            cenc: {
                perSampleIvSize: 8,
                ivs: Uint8Array.from({ length: 24 }, (_, i) => i),
                subsampleCounts: [1, 2, 0],
                clearBytes: [1, 1, 1],
                protectedBytes: [3, 1, 2],
            },
        });
        const frames = sliceFrames(e, new Uint8Array(9));
        expect(Array.from(frames[0]!.cenc!.iv)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
        expect(frames[0]!.cenc!.subsamples).toEqual([{ clearBytes: 1, protectedBytes: 3 }]);
        expect(frames[1]!.cenc!.subsamples).toEqual([{ clearBytes: 1, protectedBytes: 1 }, { clearBytes: 1, protectedBytes: 2 }]);
        expect(Array.from(frames[2]!.cenc!.iv)).toEqual([16, 17, 18, 19, 20, 21, 22, 23]);
        expect(frames[2]!.cenc!.subsamples).toEqual([]);
    });

    it('a whole-sample protected track (no subsample map) reports null subsamples', () => {
        const e = effective({
            cenc: { perSampleIvSize: 16, ivs: new Uint8Array(48), subsampleCounts: null, clearBytes: null, protectedBytes: null },
        });
        const frames = sliceFrames(e, new Uint8Array(9));
        expect(frames[1]!.cenc).toEqual({ iv: new Uint8Array(16), subsamples: null });
    });

    it('matches what a track decoder reconstructs for a real encoded group', () => {
        const init = videoInit();
        const context = parseLocmafTrackContext(init);
        const encoder = new LocmafEncoder();
        const state = new LocmafGroupState();
        const decoder = new LocmafTrackDecoder(init);
        const samples = [
            { duration: 3000, size: 5, flags: SYNC_FLAGS },
            { duration: 3000, size: 7, flags: NON_SYNC_FLAGS },
        ];
        const chunk = buildChunk({ bmdt: 180000, samples });
        const object = serializeLocmafObject(encoder.encode(chunk, state, context, false, 0n));
        const result = decoder.push(3n, 0n, object);
        expect(result.kind).toBe('chunk');
        if (result.kind !== 'chunk') return;
        const frames = sliceFrames(result.effective, result.mdat);
        expect(frames.length).toBe(2);
        expect(frames.map((f) => f.data.length)).toEqual([5, 7]);
        expect(frames[0]!.decodeTime).toBe(180000n);
        expect(frames[1]!.decodeTime).toBe(183000n);
        expect(frames[0]!.isSync).toBe(true);
        expect(frames[1]!.isSync).toBe(false);
        // The mdat payload the decoder exposes is the tail of the canonical chunk.
        expect(result.bytes.subarray(result.bytes.length - result.mdat.length)).toEqual(result.mdat);
    });
});

describe('ticksToMicros', () => {
    it('converts timescale ticks to microseconds with rounding', () => {
        expect(ticksToMicros(90000n, 90000)).toBe(1_000_000n);
        expect(ticksToMicros(3000n, 90000)).toBe(33_333n);
        expect(ticksToMicros(1n, 48000)).toBe(21n);
        expect(ticksToMicros(0n, 48000)).toBe(0n);
    });

    it('rejects a non-positive timescale', () => {
        expect(() => ticksToMicros(1n, 0)).toThrow(LocmafFormatError);
    });
});

describe('codecDescriptionFromInit (section 16, codec configuration from the CMAF Header)', () => {
    it('returns the avcC record of a video sample entry', () => {
        expect(Array.from(codecDescriptionFromInit(videoInit())!)).toEqual([1, 100, 0, 40, 0xff, 0xe1, 0, 0, 1, 0]);
    });

    it('returns the avcC record of a protected encv entry too', () => {
        expect(Array.from(codecDescriptionFromInit(cencVideoInit(8))!)).toEqual([1, 100, 0, 40, 0xff, 0xe1, 0, 0, 1, 0]);
    });

    it('returns the AudioSpecificConfig from an mp4a esds', () => {
        expect(Array.from(codecDescriptionFromInit(audioInit())!)).toEqual([0x12, 0x10]);
    });

    it('returns null for a Header without a sample entry', () => {
        expect(codecDescriptionFromInit(buildInit({ trackId: 1, timescale: 90000, handler: 'vide', emptyStsd: true }))).toBeNull();
    });

    /** A CMAF Header whose only track is a sound track with this sample entry. */
    const audioHeader = (entry: Uint8Array) => concat(
        isoBox('ftyp', ascii('iso6'), u32(0), ascii('cmfc')),
        isoBox('moov', isoBox('trak', isoBox('mdia',
            fullBox('hdlr', 0, 0, u32(0), ascii('soun'), new Uint8Array(12), u8(0)),
            isoBox('minf', isoBox('stbl', fullBox('stsd', 0, 0, u32(1), entry)))))));
    const audioFields = (channels: number) =>
        concat(new Uint8Array(6), u16(1), new Uint8Array(8), u16(channels), u16(16), u16(0), u16(0), u32(48000 << 16));
    const opusHeader = (dops: number[]) =>
        audioHeader(isoBox('Opus', audioFields(dops[1]!), isoBox('dOps', Uint8Array.from(dops))));
    const OPUS_HEAD = [0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64];

    it('rebuilds an OpusHead from dOps: magic, version 1, fields little-endian', () => {
        // dOps: version 0, 2 channels, pre-skip 312, 48 kHz, gain 0, family 0.
        const head = codecDescriptionFromInit(opusHeader([0, 2, 0x01, 0x38, 0, 0, 0xbb, 0x80, 0, 0, 0]))!;
        expect(Array.from(head)).toEqual([...OPUS_HEAD, 1, 2, 0x38, 0x01, 0x80, 0xbb, 0, 0, 0, 0, 0]);
    });

    it('carries a dOps channel mapping table and a negative output gain into the OpusHead', () => {
        // 6 channels, gain -256 (Q7.8), family 1: 4 streams, 2 coupled, mapping 0 4 1 2 3 5.
        const head = codecDescriptionFromInit(opusHeader(
            [0, 6, 0x01, 0x38, 0, 0, 0xbb, 0x80, 0xff, 0x00, 1, 4, 2, 0, 4, 1, 2, 3, 5]))!;
        expect(Array.from(head)).toEqual(
            [...OPUS_HEAD, 1, 6, 0x38, 0x01, 0x80, 0xbb, 0, 0, 0x00, 0xff, 1, 4, 2, 0, 4, 1, 2, 3, 5]);
    });

    it('rejects a truncated dOps', () => {
        expect(() => codecDescriptionFromInit(opusHeader([0, 2, 0x01, 0x38, 0, 0, 0xbb, 0x80, 0, 0])))
            .toThrow(LocmafFormatError);
        expect(() => codecDescriptionFromInit(opusHeader([0, 2, 0x01, 0x38, 0, 0, 0xbb, 0x80, 0, 0, 1, 1])))
            .toThrow(LocmafFormatError);
    });

    it('prefixes the dfLa metadata blocks with "fLaC"', () => {
        const streamInfo = concat(Uint8Array.of(0x80, 0, 0, 34), new Uint8Array(34).fill(7));
        const description = codecDescriptionFromInit(
            audioHeader(isoBox('fLaC', audioFields(2), fullBox('dfLa', 0, 0, streamInfo))))!;
        expect(Array.from(description)).toEqual([0x66, 0x4c, 0x61, 0x43, ...streamInfo]);
    });
});

describe('isCmafHeader', () => {
    it('recognises ftyp followed by moov and nothing else', () => {
        expect(isCmafHeader(videoInit())).toBe(true);
        expect(isCmafHeader(Uint8Array.of(0, 0, 0, 8, 0x66, 0x72, 0x65, 0x65))).toBe(false);
        expect(isCmafHeader(new Uint8Array(3))).toBe(false);
    });
});
