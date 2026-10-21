/**
 * Draft 22 end to end over the in-memory loopback: g5-broadcast's session
 * publishes, a real MoqtPlayer subscribes. The player joins the catalog with a
 * fill (draft 22 has no Joining FETCH) and subscribes to video and audio.
 */

import { describe, it, expect, vi } from 'vitest';
import { connectedPair } from '../../packages/webtransport/src/testkit/pair.js';
import { MoqtPlayer } from '@openmoq/player';
import type { MoqtConnection } from '@openmoq/webtransport';
import { BroadcastSession } from './broadcast-session.js';
import type { BroadcastSessionConnection } from './broadcast-session.js';
import type { BroadcastCatalogParams } from './catalog-publisher.js';

const CATALOG: BroadcastCatalogParams = {
  videoCodec: 'avc1.42001f', width: 1280, height: 720, fps: 30, videoBitrate: 2_000_000,
  targetLatencyMs: 200, audio: { sampleRate: 48_000, channels: 1 },
};
const td = new TextDecoder();

describe('g5-broadcast on draft 22', () => {
  it('a player joins the catalog by fill and subscribes to video and audio', async () => {
    const { client, server } = await connectedPair(22);
    const lines: string[] = [];
    const session = new BroadcastSession(server as unknown as BroadcastSessionConnection, {
      catalog: CATALOG, publisher: { wrapInt: (n: bigint) => n, draft: 22 },
      log: (l: string) => lines.push(l), catalogIntervalMs: 0,
    });
    server.onSubscribe = (requestId, _ns, name, parameters) =>
      session.handleSubscribe(requestId, td.decode(name), parameters);

    const player = new MoqtPlayer({
      url: 'https://unused.example/moq', namespace: 'live/test', connection: client as unknown as MoqtConnection,
      createTransport: async () => ({}) as never, draftVersion: 22,
      createMediaSource: () => ({
        initialize: vi.fn(), appendChunk: vi.fn(), endOfStream: vi.fn(), reset: vi.fn(),
        mediaElement: null, destroy: vi.fn(), onFirstFrame: null, onError: null, onStall: null,
      }),
      createCmafAssembler: () => ({ push: vi.fn(), getEpoch: () => null, reset: vi.fn(), destroy: vi.fn() }),
    });
    const catalogs: unknown[] = [];
    player.on('catalog_received', (e) => catalogs.push(e.catalog));
    try {
      await player.load();
      await vi.waitFor(() => expect(catalogs).toHaveLength(1));
      await vi.waitFor(() => expect(lines).toEqual(expect.arrayContaining([
        expect.stringMatching(/^catalog: fill served/),
        'video: SUBSCRIBE_OK',
        'audio: SUBSCRIBE_OK',
      ])));
      expect((catalogs[0] as { tracks: Array<{ name: string }> }).tracks.map((t) => t.name).sort())
        .toEqual(['audio', 'video']);
    } finally {
      await player.destroy();
      await session.shutdown?.();
      await client.close();
      await server.close();
    }
  });
});
