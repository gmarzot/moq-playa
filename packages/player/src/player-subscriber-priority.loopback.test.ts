/**
 * SUBSCRIBER_PRIORITY as the peer decodes it: a real MoqtPlayer drives a real
 * MoqtConnection client over the in-memory loopback, and the server connection
 * reports the parameters it parsed from each SUBSCRIBE.
 *
 * @see draft-ietf-moq-transport-22 §5.1.2, §9.20.7, §3.4
 */

import { describe, expect, it } from 'vitest';
import { connectedPair } from '../../webtransport/src/testkit/pair.js';
import type { MoqtConnection } from '@openmoq/webtransport';
import type { CatalogTrack } from '@openmoq/msf';
import { MoqtPlayer } from './player.js';
import type { MoqtPlayerConfig } from './config.js';

const td = new TextDecoder();
const flush = () => new Promise((r) => setTimeout(r, 0));
const settle = async (n = 16) => { for (let i = 0; i < n; i++) await flush(); };
const SUBSCRIBER_PRIORITY = 0x20n;
const FILL_PARAMETERS = 0x23n;

const LADDER: CatalogTrack[] = [
  { name: 'v3000', packaging: 'loc', isLive: true, role: 'video', renderGroup: 1, altGroup: 1,
    codec: 'avc1.640028', width: 1920, height: 1080, bitrate: 3_000_000 },
  { name: 'v1500', packaging: 'loc', isLive: true, role: 'video', renderGroup: 1, altGroup: 1,
    codec: 'avc1.64001f', width: 1280, height: 720, bitrate: 1_500_000 },
  { name: 'v500', packaging: 'loc', isLive: true, role: 'video', renderGroup: 1, altGroup: 1,
    codec: 'avc1.4d4015', width: 480, height: 360, bitrate: 500_000 },
  { name: 'audio', packaging: 'loc', isLive: true, role: 'audio', renderGroup: 1,
    codec: 'opus', samplerate: 48000, channelConfig: '2', bitrate: 128_000 },
];

interface Received { name: string; priority: bigint | undefined; fill: boolean }

async function start(draft: 18 | 22, config: Partial<MoqtPlayerConfig> = {}) {
  const { client, server, errors } = await connectedPair(draft);
  const received: Received[] = [];
  let alias = 40n;
  (server as unknown as MoqtConnection).onSubscribe = (requestId, _ns, trackName, params) => {
    const map = params as Map<bigint, unknown[]> | undefined;
    received.push({
      name: td.decode(trackName),
      priority: map?.get(SUBSCRIBER_PRIORITY)?.[0] as bigint | undefined,
      fill: map?.has(FILL_PARAMETERS) === true,
    });
    void (server as unknown as MoqtConnection).acceptSubscribe(requestId, alias++).catch(() => {});
  };
  const player = new MoqtPlayer({
    url: 'https://unused.example/moq',
    namespace: 'live/broadcast',
    connection: client as unknown as MoqtConnection,
    createTransport: async () => ({}) as never,
    draftVersion: draft,
    catalog: { tracks: LADDER },
    ...config,
  });
  const playerErrors: unknown[] = [];
  player.on('error', (e) => playerErrors.push(e.error));
  await player.load();
  await settle();
  const priorityOf = (name: string): bigint | undefined => received.filter((r) => r.name === name).at(-1)?.priority;
  return { player, received, priorityOf, errors, playerErrors };
}

describe.each([18, 22] as const)('draft %d SUBSCRIBER_PRIORITY on the wire', (draft) => {
  it('audio subscribes at 126, video at 128 by default', async () => {
    const f = await start(draft);
    try {
      expect(f.received.map((r) => r.name).sort()).toEqual(['audio', 'v1500']);
      expect(f.priorityOf('v1500')).toBe(128n);
      expect(f.priorityOf('audio')).toBe(126n);
      expect(f.playerErrors).toEqual([]);
      expect(f.errors).toEqual([]);
    } finally { await f.player.destroy(); }
  });

  it('a configured base shifts video and audio together', async () => {
    const f = await start(draft, { subscriberPriority: 64 });
    try {
      expect(f.priorityOf('v1500')).toBe(64n);
      expect(f.priorityOf('audio')).toBe(62n);
    } finally { await f.player.destroy(); }
  });

  it('a down-switch target goes ahead of the outgoing rendition and behind audio', async () => {
    const f = await start(draft);
    try {
      await f.player.selectVideoTrack('v500');
      await settle();
      expect(f.priorityOf('v500')).toBe(127n);
      expect(f.priorityOf('v1500')).toBe(128n);
      expect(f.priorityOf('audio')).toBe(126n);
      expect(f.errors).toEqual([]);
    } finally { await f.player.destroy(); }
  });

  it('an up-switch target stays at the base', async () => {
    const f = await start(draft);
    try {
      await f.player.selectVideoTrack('v3000');
      await settle();
      expect(f.priorityOf('v3000')).toBe(128n);
    } finally { await f.player.destroy(); }
  });
});

describe('draft 22 fill', () => {
  it('a warm-start SUBSCRIBE carries its fill and the priority the fill inherits (§3.4)', async () => {
    const f = await start(22, { warmStartCurrentGroup: true });
    try {
      const audio = f.received.find((r) => r.name === 'audio');
      const video = f.received.find((r) => r.name === 'v1500');
      expect(audio).toEqual({ name: 'audio', priority: 126n, fill: true });
      expect(video).toEqual({ name: 'v1500', priority: 128n, fill: true });
      expect(f.errors).toEqual([]);
    } finally { await f.player.destroy(); }
  });
});
