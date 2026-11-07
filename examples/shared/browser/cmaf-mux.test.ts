/**
 * The CMAF muxer's output, read back through the player's own MP4 parsers.
 */
import { describe, it, expect } from 'vitest';
import { aacAudioSpecificConfig, buildAudioInit, buildChunk, buildVideoInit, opusHead, opusPreSkip } from './cmaf-mux.js';
import { codecDescriptionFromInit } from '@openmoq/locmaf';
import {
  filterInitSegment, readBaseMediaDecodeTime, readMdhdTimescale, readSegmentTimeRanges, readTrexDefaults,
} from '../../../packages/browser/src/mp4-box.js';

const TS = 1_000_000;
const AVCC = new Uint8Array([0x01, 0x42, 0x00, 0x1f, 0xff, 0xe1, 0x00, 0x04, 0x67, 0x42, 0x00, 0x1f, 0x01, 0x00, 0x02, 0x68, 0xce]);

function topLevel(bytes: Uint8Array): string[] {
  const types: string[] = [];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let pos = 0; pos + 8 <= bytes.byteLength;) {
    const size = view.getUint32(pos);
    types.push(new TextDecoder().decode(bytes.subarray(pos + 4, pos + 8)));
    if (size < 8) break;
    pos += size;
  }
  return types;
}

describe('cmaf-mux', () => {
  it('builds a chunk whose decode range the player reads back exactly', () => {
    const data = new Uint8Array([0, 0, 0, 2, 0x65, 0x88]);
    const chunk = buildChunk({
      trackId: 1, sequence: 7, baseDecodeTime: 1_759_000_000_000_000n, duration: 41_708, keyframe: true, data,
    });
    expect(topLevel(chunk)).toEqual(['moof', 'mdat']);
    expect(readBaseMediaDecodeTime(chunk)).toBe(1_759_000_000_000_000n);
    expect(readSegmentTimeRanges(chunk)).toEqual([
      { startTime: 1_759_000_000_000_000n, endTime: 1_759_000_000_041_708n, sampleCount: 1 },
    ]);
    expect(chunk.subarray(chunk.byteLength - data.byteLength)).toEqual(data);
  });

  it('builds a video init with the track timescale and a trex for the track', () => {
    const init = buildVideoInit({
      trackId: 1, timescale: TS, codec: 'avc1.42001f', width: 1280, height: 720, description: AVCC,
    });
    expect(topLevel(init)).toEqual(['ftyp', 'moov']);
    expect(readMdhdTimescale(init)).toBe(TS);
    expect([...readTrexDefaults(init).keys()]).toEqual([1]);
    expect(filterInitSegment(init, 'vide').byteLength).toBeGreaterThan(0);
  });

  it('builds an Opus audio init', () => {
    const init = buildAudioInit({ trackId: 2, timescale: TS, sampleRate: 48_000, channels: 1, preSkip: 312 });
    expect(topLevel(init)).toEqual(['ftyp', 'moov']);
    expect(readMdhdTimescale(init)).toBe(TS);
    expect([...readTrexDefaults(init).keys()]).toEqual([2]);
    expect(filterInitSegment(init, 'soun').byteLength).toBeGreaterThan(0);
  });

  it('refuses a video codec it cannot describe', () => {
    expect(() => buildVideoInit({
      trackId: 1, timescale: TS, codec: 'vp8', width: 640, height: 360, description: AVCC,
    })).toThrow(/does not support/);
  });

  it('carries an HEVC hvcC', () => {
    const hvcc = new Uint8Array([0x01, 0x01, 0x60, 0, 0, 0, 0x90, 0, 0, 0, 0, 0, 0x5d]);
    const init = buildVideoInit({
      trackId: 1, timescale: TS, codec: 'hvc1.1.6.L93.B0', width: 1280, height: 720, description: hvcc,
    });
    expect(codecDescriptionFromInit(init)).toEqual(hvcc);
  });

  it('builds a VP9 vpcC from the codec string', () => {
    const init = buildVideoInit({
      trackId: 1, timescale: TS, codec: 'vp09.00.31.08', width: 1280, height: 720, description: new Uint8Array(),
    });
    const vpcc = codecDescriptionFromInit(init)!;
    // version 1, flags, profile 0, level 31, 8-bit 4:2:0, BT.709, no init data.
    expect([...vpcc]).toEqual([1, 0, 0, 0, 0, 31, 0x82, 1, 1, 1, 0, 0]);
  });

  it('builds an AAC audio init whose esds carries the AudioSpecificConfig', () => {
    const init = buildAudioInit({ trackId: 2, timescale: TS, codec: 'mp4a.40.2', sampleRate: 48_000, channels: 1 });
    expect(filterInitSegment(init, 'soun').byteLength).toBeGreaterThan(0);
    expect(codecDescriptionFromInit(init)).toEqual(new Uint8Array([0x11, 0x88]));
  });

  it.each([
    [48_000, 1, [0x11, 0x88]],
    [44_100, 2, [0x12, 0x10]],
    [48_000, 2, [0x11, 0x90]],
  ])('AAC-LC AudioSpecificConfig for %i Hz, %i ch', (rate, ch, bytes) => {
    expect([...aacAudioSpecificConfig(rate, ch)]).toEqual(bytes);
  });

  it('writes 48 kHz in both the Opus sample entry and its dOps, whatever the capture rate', () => {
    const init = buildAudioInit({ trackId: 2, timescale: TS, codec: 'opus', sampleRate: 44_100, channels: 2 });
    const view = new DataView(init.buffer, init.byteOffset, init.byteLength);
    const at = (type: string) => {
      for (let i = 4; i + 4 <= init.byteLength; i++) {
        if (new TextDecoder().decode(init.subarray(i, i + 4)) === type) return i - 4;
      }
      throw new Error(`no ${type}`);
    };
    // Opus sample entry: header 8, reserved 6, data_reference_index 2, reserved 8, channels 2, size 2, 4, then 16.16 rate.
    expect(view.getUint32(at('Opus') + 32) >>> 16).toBe(48_000);
    // dOps: header 8, version 1, channels 1, pre-skip 2, then InputSampleRate.
    expect(view.getUint32(at('dOps') + 12)).toBe(48_000);
  });

  it('writes an OpusHead the Opus pre-skip reader agrees with', () => {
    const head = opusHead(48_000, 2);
    expect(head.byteLength).toBe(19);
    expect(head[9]).toBe(2);
    expect(opusPreSkip(head)).toBe(312);
  });

  it('reads the Opus pre-skip from an OpusHead', () => {
    const head = new Uint8Array(19);
    head.set(new TextEncoder().encode('OpusHead'));
    head[8] = 1; head[9] = 1; head[10] = 0x38; head[11] = 0x01; // version 1, 1 ch, pre-skip 312
    expect(opusPreSkip(head)).toBe(312);
    expect(opusPreSkip(undefined)).toBeUndefined();
    expect(opusPreSkip(new Uint8Array(4))).toBeUndefined();
  });
});
