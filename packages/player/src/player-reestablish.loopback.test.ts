/**
 * Re-establishing playback after the relay restarts, with followNamespace:
 * the session dies, the reconnect finds no publisher (catalog DOES_NOT_EXIST),
 * the namespace returns and a fresh session is opened.
 *
 * A real player and real draft-18 connections over the in-memory loopback, one
 * server endpoint per session the player opens.
 *
 * Uses an internal relative testkit import by design — the testkit is not a
 * published export of @openmoq/webtransport.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { varint } from '@openmoq/transport';
import { createLoopback } from '../../webtransport/src/testkit/loopback.js';
import { MoqtConnection } from '../../webtransport/src/adapter.js';
import { MoqtPlayer } from './player.js';
import { NamespaceFollower } from './namespace-follow.js';
import { PlayerState } from './state.js';

const enc = (o: unknown) => new TextEncoder().encode(JSON.stringify(o));
const td = new TextDecoder();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const DOES_NOT_EXIST = 0x10n;

const CATALOG = {
  version: 'draft-01',
  tracks: [
    { name: 'video', packaging: 'loc', renderGroup: 1, isLive: true, role: 'video',
      codec: 'av01.0.08M.10', width: 1920, height: 1080, bitrate: 1_500_000 },
    { name: 'audio', packaging: 'loc', renderGroup: 1, isLive: true, role: 'audio',
      codec: 'opus', samplerate: 48000, channelConfig: '2', bitrate: 32_000 },
  ],
};

/** One session's server end and what it answered. */
interface Session {
  server: MoqtConnection;
  /** Track names subscribed, suffixed `(DNE)` when refused. */
  subs: string[];
  nsRequestId: bigint | null;
}

/** A relay whose catalog and media tracks can each be published or not. */
function relay(opts: { refusalDelayMs: number }) {
  const published = { catalog: true, media: true };
  const sessions: Session[] = [];
  let alias = 40n;

  const wire = (s: Session): void => {
    const { server } = s;
    server.onSubscribe = (requestId, _ns, trackName) => {
      const name = td.decode(trackName);
      const up = name === 'catalog' ? published.catalog : published.media;
      s.subs.push(up ? name : `${name}(DNE)`);
      void (async () => {
        if (!up) {
          if (opts.refusalDelayMs > 0) await sleep(opts.refusalDelayMs);
          await server.rejectSubscribe(requestId, DOES_NOT_EXIST, 'track does not exist');
          return;
        }
        await server.acceptSubscribe(requestId, alias++, name === 'catalog'
          ? { parameters: new Map([[0x09n, [{ group: 5n, object: 0n }]]]) as never }
          : undefined);
      })();
    };
    server.onFetch = (requestId) => {
      void (async () => {
        const range = server.resolveJoiningFetch(requestId);
        await server.acceptFetch(requestId, { endLocation: range.endLocation });
        const sid = await server.openFetchStream(requestId);
        await server.sendFetchObject(sid, {
          groupId: 5n, subgroupId: 0n, objectId: 0n, publisherPriority: 5, payload: enc(CATALOG),
        });
        await server.closeFetchStream(sid);
      })();
    };
    server.onSubscribeNamespace = (requestId) => {
      s.nsRequestId = requestId;
      void (async () => {
        await server.acceptSubscribeNamespace(requestId);
        if (published.catalog) await server.sendNamespace(requestId, []);
      })();
    };
  };

  return {
    published,
    sessions,
    createTransport: async () => {
      const { a, b } = createLoopback({});
      const s: Session = { server: new MoqtConnection(18, { role: 'server' }), subs: [], nsRequestId: null };
      wire(s);
      sessions.push(s);
      void s.server.connect(b, {});
      return a as never;
    },
    /** The relay restarts: the current session dies and nothing is published. */
    async restart(): Promise<void> {
      published.catalog = false;
      published.media = false;
      await sessions[sessions.length - 1]!.server.close(varint(0n), 'relay restart');
    },
    /** The publisher returns: NAMESPACE on every session following it. */
    async republish(): Promise<void> {
      published.catalog = true;
      for (const s of sessions) {
        if (s.nsRequestId !== null) await s.server.sendNamespace(s.nsRequestId, []).catch(() => {});
      }
    },
  };
}

async function startPlaying(r: ReturnType<typeof relay>) {
  const player = new MoqtPlayer({
    url: 'https://unused.example/moq',
    namespace: 'live/broadcast',
    draftVersion: 18,
    followNamespace: true,
    createConnection: () => new MoqtConnection(18) as never,
    createTransport: r.createTransport,
  });
  const errors: { severity: string; message: string }[] = [];
  player.on('error', (e) => errors.push({ severity: e.error.severity, message: e.error.message }));
  await player.load();
  await sleep(20);
  player.play();
  expect(r.sessions[0]!.subs).toEqual(['catalog', 'video', 'audio']);
  return { player, errors };
}

const RECONNECT_DELAYS_MS = (MoqtPlayer as unknown as { RECONNECT_DELAYS_MS: number[] }).RECONNECT_DELAYS_MS;
const SETTLE_MS = NamespaceFollower.RETURN_SETTLE_MS;

describe('re-establishing after a relay restart (followNamespace, d18 loopback)', () => {
  beforeEach(() => {
    (MoqtPlayer as unknown as { RECONNECT_DELAYS_MS: number[] }).RECONNECT_DELAYS_MS = [10, 20, 40];
    NamespaceFollower.RETURN_SETTLE_MS = 20;
  });
  afterEach(() => {
    (MoqtPlayer as unknown as { RECONNECT_DELAYS_MS: number[] }).RECONNECT_DELAYS_MS = RECONNECT_DELAYS_MS;
    NamespaceFollower.RETURN_SETTLE_MS = SETTLE_MS;
  });

  it('retries media refused as not existing on the re-established session', async () => {
    const r = relay({ refusalDelayMs: 20 });
    const { player, errors } = await startPlaying(r);

    await r.restart();
    await sleep(200);
    expect(r.sessions[1]!.subs).toEqual(['catalog(DNE)']);

    // The catalog returns before the media tracks do.
    await r.republish();
    await sleep(200);
    const reestablished = r.sessions[2]!;
    expect(reestablished.subs).toEqual(['catalog', 'video(DNE)', 'audio(DNE)', 'video(DNE)', 'audio(DNE)']);

    r.published.media = true;
    await sleep(1_500);
    expect(reestablished.subs.slice(5)).toEqual(['video', 'audio']);
    expect(r.sessions).toHaveLength(3);
    expect(errors.filter((e) => e.severity === 'fatal')).toEqual([]);
    await player.destroy();
  }, 10_000);

  it('a catalog refusal arriving before SUBSCRIBE_NAMESPACE is sent waits for the publisher', async () => {
    const r = relay({ refusalDelayMs: 0 });
    const { player, errors } = await startPlaying(r);

    await r.restart();
    await sleep(200);
    expect(r.sessions[1]!.subs).toEqual(['catalog(DNE)']);
    expect(errors.filter((e) => e.severity === 'fatal')).toEqual([]);
    expect(errors.some((e) => /waiting for the publisher/.test(e.message))).toBe(true);
    expect(player.state).toBe(PlayerState.PLAYING);

    r.published.media = true;
    await r.republish();
    await sleep(300);
    expect(r.sessions[2]!.subs).toEqual(['catalog', 'video', 'audio']);
    await player.destroy();
  }, 10_000);
});
