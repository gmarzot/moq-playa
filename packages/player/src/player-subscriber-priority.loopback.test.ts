/**
 * SUBSCRIBER_PRIORITY as the peer decodes it: a real MoqtPlayer drives a real
 * MoqtConnection client over the in-memory loopback, and the server connection
 * reports the parameters it parsed from each SUBSCRIBE and FETCH.
 *
 * @see draft-ietf-moq-transport-22 §5.1.2, §9.20.7, §3.4
 */

import { describe, expect, it } from 'vitest';
import { connectedPair } from '../../webtransport/src/testkit/pair.js';
import type { MoqtConnection } from '@openmoq/webtransport';
import type { Fetch } from '@openmoq/transport';
import type { CatalogTrack } from '@openmoq/msf';
import { MoqtPlayer } from './player.js';
import type { MoqtPlayerConfig } from './config.js';

const td = new TextDecoder();
const flush = () => new Promise((r) => setTimeout(r, 0));
const settle = async (n = 16) => { for (let i = 0; i < n; i++) await flush(); };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
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
interface ReceivedFetch { name: string; joining: boolean; priority: bigint | undefined }

async function start(draft: 18 | 22, config: Partial<MoqtPlayerConfig> = {}) {
  const pair = await connectedPair(draft);
  const { client, errors } = pair;
  const server = pair.server as unknown as MoqtConnection;
  const received: Received[] = [];
  const fetches: ReceivedFetch[] = [];
  const subs = new Map<bigint, { name: string; alias: bigint }>();
  let alias = 40n;
  server.onSubscribe = (requestId, _ns, trackName, params) => {
    const map = params as Map<bigint, unknown[]> | undefined;
    const name = td.decode(trackName);
    received.push({
      name,
      priority: map?.get(SUBSCRIBER_PRIORITY)?.[0] as bigint | undefined,
      fill: map?.has(FILL_PARAMETERS) === true,
    });
    subs.set(requestId, { name, alias });
    void server.acceptSubscribe(requestId, alias++).catch(() => {});
  };
  server.onFetch = (_requestId, msg: Fetch) => {
    const joining = msg.fetch.fetchType !== 0x1;
    fetches.push({
      name: msg.fetch.fetchType === 0x1 ? td.decode(msg.fetch.trackName)
        : subs.get(BigInt(msg.fetch.joiningRequestId))?.name ?? '?',
      joining,
      priority: msg.parameters.get(SUBSCRIBER_PRIORITY)?.[0] as bigint | undefined,
    });
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
  const aliasOf = (name: string): bigint => [...subs.values()].find((sub) => sub.name === name)!.alias;
  return { player, server, received, fetches, priorityOf, aliasOf, errors, playerErrors };
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

describe('draft 18 Joining FETCH', () => {
  it('a warm-start join carries its track\'s priority', async () => {
    const f = await start(18, { warmStartCurrentGroup: true });
    try {
      expect(f.fetches).toHaveLength(2);
      expect(f.fetches).toEqual(expect.arrayContaining([
        { name: 'audio', joining: true, priority: 126n },
        { name: 'v1500', joining: true, priority: 128n },
      ]));
    } finally { await f.player.destroy(); }
  });
});

describe.each([18, 22] as const)('draft %d audio repair', (draft) => {
  it('a lost audio datagram is fetched at the audio priority', async () => {
    const f = await start(draft, { latencyMode: 'smooth', subscriberPriority: 64 });
    try {
      const alias = f.aliasOf('audio');
      await f.server.sendDatagram(alias, 10n, 0n, Uint8Array.of(0xaa));
      await f.server.sendDatagram(alias, 12n, 0n, Uint8Array.of(0xaa));
      await sleep(60);
      await settle();
      expect(f.fetches).toEqual([{ name: 'audio', joining: false, priority: 62n }]);
    } finally { await f.player.destroy(); }
  });
});
