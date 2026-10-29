/**
 * A CMAF publisher restarts and numbers its groups and decode times from zero
 * again; the player resubscribes and the new epoch must reach the MSE sink.
 *
 * A real player, real assembler and real draft-18 connections over the
 * in-memory loopback. The sink stands in for MseMediaSource's committed group
 * floor: video below the previous committed group is dropped, as in appendChunk.
 *
 * Uses internal relative imports by design: the testkit is not a published
 * export of @openmoq/webtransport, and @openmoq/browser depends on this package.
 */

import { describe, expect, it, vi } from 'vitest';
import { varint } from '@openmoq/transport';
import { connectedPair } from '../../webtransport/src/testkit/pair.js';
import { flush } from '../../webtransport/src/testkit/loopback.js';
import { CmafAssembler, type CmafAssemblerOptions } from '../../browser/src/cmaf-assembler.js';
import { readBaseMediaDecodeTime } from '../../browser/src/mp4-box.js';
import { MoqtPlayer } from './player.js';

const VIDEO_TS = 90_000;
const AUDIO_TS = 48_000;
const VIDEO_DUR = 3_000;  // one 30 fps frame
const AUDIO_DUR = 1_024;  // one AAC frame

const u32 = (v: number): number[] => [v >>> 24, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff];
const box = (type: string, ...parts: number[][]): number[] => {
  const body = parts.flat();
  return [...u32(8 + body.length), ...[...type].map((c) => c.charCodeAt(0)), ...body];
};
const fullBox = (type: string, ...parts: number[][]): number[] => box(type, u32(0), ...parts);

/** moov(trak(mdia(mdhd))): carries the timescale the assembler reads. */
const init = (timescale: number): string => btoa(String.fromCharCode(
  ...box('moov', box('trak', box('mdia', fullBox('mdhd', u32(0), u32(0), u32(timescale), u32(0), u32(0))))),
));

/** One CMAF chunk: moof with a one-sample trun at `bmd`, then its mdat. */
const chunk = (bmd: number, duration: number): Uint8Array => new Uint8Array([
  ...box('moof',
    fullBox('mfhd', u32(1)),
    box('traf',
      box('tfhd', u32(0x000008), u32(1), u32(duration)),
      fullBox('tfdt', u32(bmd)),
      fullBox('trun', u32(1)))),
  ...box('mdat', [0xaa]),
]);

const CATALOG = {
  version: 1,
  tracks: [
    { name: 'vide_1', packaging: 'cmaf', isLive: true, role: 'video', renderGroup: 1, codec: 'avc1.640029',
      width: 1920, height: 1080, bitrate: 1_500_000, initData: init(VIDEO_TS) },
    { name: 'soun_2', packaging: 'cmaf', isLive: true, role: 'audio', renderGroup: 1, codec: 'mp4a.40.2',
      samplerate: 48000, channelConfig: '2', bitrate: 128_000, initData: init(AUDIO_TS) },
  ],
};

interface Appended { mediaType: 'video' | 'audio'; groupId: bigint; bmd: bigint }

/** MSE sink stub with MseMediaSource's committed-group-floor contract. */
function floorSink() {
  const floors = new Map<string, bigint>();
  const appended: Appended[] = [];
  return {
    appended,
    initialize: vi.fn(), endOfStream: vi.fn(), reset: vi.fn(), destroy: vi.fn(),
    mediaElement: null, onFirstFrame: null, onError: null, onStall: null,
    appendChunk(mediaType: 'video' | 'audio', data: Uint8Array, trackName: string, groupId?: bigint) {
      const key = `${mediaType}:${trackName}`;
      const floor = floors.get(key);
      if (mediaType === 'video' && groupId !== undefined && floor !== undefined && groupId + 1n < floor) return;
      appended.push({ mediaType, groupId: groupId ?? -1n, bmd: readBaseMediaDecodeTime(data) ?? -1n });
      if (groupId !== undefined && (floor === undefined || groupId > floor)) floors.set(key, groupId);
    },
    getCommittedGroupFloor: (mediaType: string, trackName: string) => floors.get(`${mediaType}:${trackName}`),
    clearGroupFloor: (mediaType: string, trackName: string) => { floors.delete(`${mediaType}:${trackName}`); },
    clearTimeline: (mediaType: string, trackName: string) => { floors.delete(`${mediaType}:${trackName}`); },
  };
}

describe('CMAF publisher restart (d18 loopback)', () => {
  it('delivers the restarted publisher\'s video and audio to the MSE sink', async () => {
    const { client, server } = await connectedPair(18);
    const requests = new Map<string, bigint[]>();
    server.onSubscribe = (id, _ns, name) => {
      const track = new TextDecoder().decode(name);
      requests.set(track, [...(requests.get(track) ?? []), id]);
    };
    const sink = floorSink();
    let assembler: CmafAssembler | null = null;
    const player = new MoqtPlayer({
      url: 'https://unused.example/moq', namespace: 'live/test', connection: client,
      createTransport: async () => ({}) as never, draftVersion: 18, catalogBootstrap: 'subscribe',
      createMediaSource: () => sink,
      createCmafAssembler: (options: CmafAssemblerOptions) => (assembler = new CmafAssembler(options)),
    } as never);
    const send = async (alias: bigint, groupId: bigint, payload: Uint8Array) => {
      const stream = await server.openSubgroup(alias, groupId, 0n, { publisherPriority: 128 });
      await server.sendObject(stream, 0n, payload);
      await server.closeSubgroup(stream);
      await flush();
    };
    /** One publisher run: `count` groups of one video and one audio frame each. */
    const publish = async (aliases: { video: bigint; audio: bigint }, firstGroup: bigint, firstSec: number, count: number) => {
      for (let i = 0; i < count; i++) {
        const t = firstSec + i * 0.1;
        await send(aliases.video, firstGroup + BigInt(i), chunk(Math.round(t * VIDEO_TS), VIDEO_DUR));
        await send(aliases.audio, firstGroup + BigInt(i), chunk(Math.round(t * AUDIO_TS), AUDIO_DUR));
      }
    };
    const latest = (track: string) => requests.get(track)?.at(-1);

    try {
      await player.load();
      await vi.waitFor(() => expect(latest('catalog')).toBeDefined());
      await server.acceptSubscribe(latest('catalog')!, 100n);
      await send(100n, 1n, new TextEncoder().encode(JSON.stringify(CATALOG)));
      await vi.waitFor(() => expect(latest('soun_2')).toBeDefined());
      player.play();
      await server.acceptSubscribe(latest('vide_1')!, 4n);
      await server.acceptSubscribe(latest('soun_2')!, 5n);

      // The old publisher has run for two hours.
      await publish({ video: 4n, audio: 5n }, 15_148n, 7_200, 3);
      await vi.waitFor(() => expect(sink.appended).toHaveLength(6));

      // It ends; the restarted one numbers groups and decode times from zero.
      const [oldVideo, oldAudio] = [latest('vide_1')!, latest('soun_2')!];
      await server.publishDone(oldVideo, varint(0x0), 'publisher restart');
      await server.publishDone(oldAudio, varint(0x0), 'publisher restart');
      await vi.waitFor(() => {
        expect(latest('vide_1')).not.toBe(oldVideo);
        expect(latest('soun_2')).not.toBe(oldAudio);
      });
      await server.acceptSubscribe(latest('vide_1')!, 6n);
      await server.acceptSubscribe(latest('soun_2')!, 7n);
      await publish({ video: 6n, audio: 7n }, 0n, 0, 3);
      await vi.waitFor(() => expect(sink.appended).toHaveLength(12));

      const restarted = sink.appended.slice(6);
      for (const mediaType of ['video', 'audio'] as const) {
        const before = sink.appended.slice(0, 6).filter((a) => a.mediaType === mediaType);
        const after = restarted.filter((a) => a.mediaType === mediaType);
        expect(after.map((a) => a.groupId)).toEqual([0n, 1n, 2n]);
        // One continuous output timeline across the restart.
        const bmds = [...before, ...after].map((a) => a.bmd);
        expect(bmds).toEqual([...bmds].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0)));
        expect(after[0]!.bmd).toBeGreaterThan(before.at(-1)!.bmd);
      }
      expect(assembler!.audioOrderStats.late).toBe(0);
      expect(assembler!.videoOrderStats.late).toBe(0);
    } finally {
      await player.destroy();
      await client.close();
      await server.close();
    }
  }, 10_000);
});
