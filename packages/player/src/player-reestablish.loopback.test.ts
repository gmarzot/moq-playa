/**
 * Resuming playback when the followed namespace returns after a relay or
 * publisher restart: on the current session when nothing there can resume by
 * itself, with a fresh session as the fallback.
 *
 * A real player and real draft-18 connections over the in-memory loopback, one
 * server endpoint per session the player opens.
 *
 * Uses an internal relative testkit import by design — the testkit is not a
 * published export of @openmoq/webtransport.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { varint, PublishDoneCode18 } from '@openmoq/transport';
import { withLocPrivateProperties } from '@openmoq/loc';
import { createLoopback } from '../../webtransport/src/testkit/loopback.js';
import { MoqtConnection } from '../../webtransport/src/adapter.js';
import { MoqtPlayer } from './player.js';
import { NamespaceFollower } from './namespace-follow.js';
import { PlayerState } from './state.js';

const enc = (o: unknown) => new TextEncoder().encode(JSON.stringify(o));
const td = new TextDecoder();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const DOES_NOT_EXIST = 0x10n;

const CATALOG_V1 = {
  version: 'draft-01',
  tracks: [
    { name: 'video', packaging: 'loc', renderGroup: 1, isLive: true, role: 'video',
      codec: 'av01.0.08M.10', width: 1920, height: 1080, bitrate: 1_500_000 },
    { name: 'audio', packaging: 'loc', renderGroup: 1, isLive: true, role: 'audio',
      codec: 'opus', samplerate: 48000, channelConfig: '2', bitrate: 32_000 },
  ],
};

/** The restarted publisher's catalog: the video track is renamed. */
const CATALOG_V2 = {
  ...CATALOG_V1,
  tracks: CATALOG_V1.tracks.map((t) => (t.name === 'video' ? { ...t, name: 'video-hd' } : t)),
};

/** A media subscription the relay serves objects on. */
interface MediaSub { alias: bigint; live: boolean; sending: Promise<void> }

/** One session's server end and what it answered. */
interface Session {
  server: MoqtConnection;
  /** Track names subscribed, suffixed `(DNE)` when refused. */
  subs: string[];
  nsRequestId: bigint | null;
  media: Map<bigint, MediaSub>;
  catalogRequestId: bigint | null;
}

/** A relay whose catalog and media tracks can each be published or not. */
function relay(opts: { refusalDelayMs: number }) {
  /** `objects`: whether accepted media subscriptions carry objects. */
  const published = { catalog: true, media: true, objects: true };
  const sessions: Session[] = [];
  let alias = 40n;
  let group = 100n;
  let catalog: object = CATALOG_V1;

  /** One object per group every 20 ms while the subscription lives. */
  const serve = async (server: MoqtConnection, sub: MediaSub): Promise<void> => {
    try {
      while (sub.live) {
        if (published.objects) {
          const sid = await server.openSubgroup(sub.alias, group++, 0n, { publisherPriority: 128 });
          await server.sendObject(sid, 0n, withLocPrivateProperties(Uint8Array.of(0xaa)));
          await server.closeSubgroup(sid);
        }
        await sleep(20);
      }
    } catch { sub.live = false; }
  };

  const wire = (s: Session): void => {
    const { server } = s;
    server.onSubscribe = (requestId, _ns, trackName) => {
      const name = td.decode(trackName);
      const up = name === 'catalog' ? published.catalog : published.media;
      s.subs.push(up ? name : `${name}(DNE)`);
      void (async () => {
        if (!up) {
          if (opts.refusalDelayMs > 0) await sleep(opts.refusalDelayMs);
          await server.rejectSubscribe(requestId, DOES_NOT_EXIST, 'track does not exist').catch(() => {});
          return;
        }
        const a = alias++;
        await server.acceptSubscribe(requestId, a, name === 'catalog'
          ? { parameters: new Map([[0x09n, [{ group: 5n, object: 0n }]]]) as never }
          : undefined);
        if (name === 'catalog') { s.catalogRequestId = requestId; return; }
        const sub: MediaSub = { alias: a, live: true, sending: Promise.resolve() };
        s.media.set(requestId, sub);
        sub.sending = serve(server, sub);
      })();
    };
    server.onFetch = (requestId) => {
      void (async () => {
        const range = server.resolveJoiningFetch(requestId);
        await server.acceptFetch(requestId, { endLocation: range.endLocation });
        const sid = await server.openFetchStream(requestId);
        await server.sendFetchObject(sid, {
          groupId: 5n, subgroupId: 0n, objectId: 0n, publisherPriority: 5, payload: enc(catalog),
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

  const following = (): Session[] => sessions.filter((s) => s.nsRequestId !== null);

  return {
    published,
    sessions,
    createTransport: async () => {
      const { a, b } = createLoopback({});
      const s: Session = {
        server: new MoqtConnection(18, { role: 'server' }), subs: [], nsRequestId: null, media: new Map(),
        catalogRequestId: null,
      };
      wire(s);
      sessions.push(s);
      void s.server.connect(b, {});
      return a as never;
    },
    /** The relay restarts: the current session dies and nothing is published. */
    async restart(): Promise<void> {
      published.catalog = false;
      published.media = false;
      const s = sessions[sessions.length - 1]!;
      for (const sub of s.media.values()) sub.live = false;
      await s.server.close(varint(0n), 'relay restart');
    },
    /** The publisher goes away: PUBLISH_DONE on the media, NAMESPACE_DONE to followers. */
    async endPublisher(): Promise<void> {
      published.media = false;
      for (const s of sessions) {
        for (const [requestId, sub] of s.media) {
          sub.live = false;
          await sub.sending;
          await s.server.publishDone(requestId, PublishDoneCode18.TRACK_ENDED, 'publisher left').catch(() => {});
        }
        s.media.clear();
      }
      await this.withdraw();
    },
    /**
     * The publisher restarts: PUBLISH_DONE on the catalog and the media,
     * NAMESPACE_DONE, and its catalog changes when it returns.
     */
    async restartPublisher(): Promise<void> {
      published.catalog = false;
      for (const s of sessions) {
        if (s.catalogRequestId === null) continue;
        await s.server.publishDone(s.catalogRequestId, PublishDoneCode18.TRACK_ENDED, 'publisher left')
          .catch(() => {});
        s.catalogRequestId = null;
      }
      await this.endPublisher();
      catalog = CATALOG_V2;
    },
    /** NAMESPACE_DONE on every session following the namespace. */
    async withdraw(): Promise<void> {
      for (const s of following()) await s.server.sendNamespaceDone(s.nsRequestId!, []).catch(() => {});
    },
    /** The publisher returns: NAMESPACE on every session following it. */
    async republish(): Promise<void> {
      published.catalog = true;
      for (const s of following()) await s.server.sendNamespace(s.nsRequestId!, []).catch(() => {});
    },
    stop(): void {
      for (const s of sessions) for (const sub of s.media.values()) sub.live = false;
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
  const objects: number[] = [];
  player.on('media_object', () => objects.push(performance.now()));
  await player.load();
  await sleep(20);
  player.play();
  expect(r.sessions[0]!.subs).toEqual(['catalog', 'video', 'audio']);
  /** Media objects received since `sinceMs`. */
  const objectsSince = (sinceMs: number): number => objects.filter((t) => t >= sinceMs).length;
  return { player, errors, objectsSince };
}

const RECONNECT_DELAYS_MS = (MoqtPlayer as unknown as { RECONNECT_DELAYS_MS: number[] }).RECONNECT_DELAYS_MS;
const SETTLE_MS = NamespaceFollower.RETURN_SETTLE_MS;
const RESUME_BOUND_MS = NamespaceFollower.RESUME_BOUND_MS;
/** Well under RETURN_SETTLE_MS, which the tests leave at its default. */
const PROMPT_MS = 300;

describe('resuming when the followed namespace returns (d18 loopback)', () => {
  let stop: (() => void) | null = null;
  beforeEach(() => {
    (MoqtPlayer as unknown as { RECONNECT_DELAYS_MS: number[] }).RECONNECT_DELAYS_MS = [10, 20, 40];
  });
  afterEach(() => {
    stop?.();
    stop = null;
    (MoqtPlayer as unknown as { RECONNECT_DELAYS_MS: number[] }).RECONNECT_DELAYS_MS = RECONNECT_DELAYS_MS;
    NamespaceFollower.RETURN_SETTLE_MS = SETTLE_MS;
    NamespaceFollower.RESUME_BOUND_MS = RESUME_BOUND_MS;
  });

  it('re-subscribes a refused catalog on the same session, and media flows', async () => {
    expect(SETTLE_MS).toBeGreaterThan(PROMPT_MS * 2);
    const r = relay({ refusalDelayMs: 20 });
    stop = () => r.stop();
    const { player, errors, objectsSince } = await startPlaying(r);

    await r.restart();
    await sleep(200);
    expect(r.sessions[1]!.subs).toEqual(['catalog(DNE)']);

    r.published.media = true;
    const returnedAt = performance.now();
    await r.republish();
    await sleep(PROMPT_MS);
    expect(r.sessions).toHaveLength(2);
    expect(r.sessions[1]!.subs).toEqual(['catalog(DNE)', 'catalog', 'video', 'audio']);
    expect(objectsSince(returnedAt)).toBeGreaterThan(0);
    expect(player.state).toBe(PlayerState.PLAYING);
    expect(errors.filter((e) => e.severity === 'fatal')).toEqual([]);
    await player.destroy();
  }, 10_000);

  it('a catalog refusal arriving before SUBSCRIBE_NAMESPACE is sent waits for the publisher', async () => {
    const r = relay({ refusalDelayMs: 0 });
    stop = () => r.stop();
    const { player, errors, objectsSince } = await startPlaying(r);

    await r.restart();
    await sleep(200);
    expect(r.sessions[1]!.subs).toEqual(['catalog(DNE)']);
    expect(errors.filter((e) => e.severity === 'fatal')).toEqual([]);
    expect(errors.some((e) => /waiting for the publisher/.test(e.message))).toBe(true);
    expect(player.state).toBe(PlayerState.PLAYING);

    r.published.media = true;
    const returnedAt = performance.now();
    await r.republish();
    await sleep(PROMPT_MS);
    expect(r.sessions).toHaveLength(2);
    expect(r.sessions[1]!.subs).toEqual(['catalog(DNE)', 'catalog', 'video', 'audio']);
    expect(objectsSince(returnedAt)).toBeGreaterThan(0);
    await player.destroy();
  }, 10_000);

  it('re-subscribes media ended by PUBLISH_DONE on the same session, and objects arrive', async () => {
    const r = relay({ refusalDelayMs: 0 });
    stop = () => r.stop();
    const { player, errors, objectsSince } = await startPlaying(r);
    await sleep(100);
    expect(objectsSince(0)).toBeGreaterThan(0);

    await r.endPublisher();
    await sleep(100);
    const quietFrom = performance.now();
    await sleep(100);
    expect(objectsSince(quietFrom)).toBe(0);

    r.published.media = true;
    const returnedAt = performance.now();
    await r.republish();
    await sleep(PROMPT_MS);
    expect(r.sessions).toHaveLength(1);
    expect(r.sessions[0]!.subs).toEqual(['catalog', 'video', 'audio', 'video', 'audio']);
    expect(objectsSince(returnedAt)).toBeGreaterThan(0);
    expect(errors.filter((e) => e.severity === 'fatal')).toEqual([]);
    await player.destroy();
  }, 10_000);

  it('a publisher restart ending the catalog too renews it on a prompt fresh session', async () => {
    const r = relay({ refusalDelayMs: 0 });
    stop = () => r.stop();
    const { player, errors, objectsSince } = await startPlaying(r);
    const catalogs: string[][] = [];
    player.on('catalog_received', (e) => catalogs.push(e.catalog.tracks.map((t) => t.name)));
    await sleep(100);

    await r.restartPublisher();
    await sleep(100);
    r.published.media = true;
    const returnedAt = performance.now();
    await r.republish();
    await sleep(PROMPT_MS);
    expect(r.sessions[0]!.subs).toEqual(['catalog', 'video', 'audio']);
    expect(r.sessions).toHaveLength(2);
    expect(r.sessions[1]!.subs).toEqual(['catalog', 'video-hd', 'audio']);
    expect(catalogs).toEqual([['video-hd', 'audio']]);
    expect(objectsSince(returnedAt)).toBeGreaterThan(0);
    expect(errors.filter((e) => e.severity === 'fatal')).toEqual([]);
    await player.destroy();
  }, 10_000);

  it('falls back to a fresh session when the in-session resume is refused', async () => {
    const r = relay({ refusalDelayMs: 20 });
    stop = () => r.stop();
    const { player, errors, objectsSince } = await startPlaying(r);

    await r.restart();
    await sleep(200);
    expect(r.sessions[1]!.subs).toEqual(['catalog(DNE)']);

    // The catalog returns before the media tracks do. Each refusal also retries once at once.
    await r.republish();
    await sleep(PROMPT_MS);
    expect(r.sessions[1]!.subs).toEqual(
      ['catalog(DNE)', 'catalog', 'video(DNE)', 'audio(DNE)', 'video(DNE)', 'audio(DNE)']);
    expect(r.sessions).toHaveLength(3);
    const reestablished = r.sessions[2]!;
    expect(reestablished.subs.slice(0, 3)).toEqual(['catalog', 'video(DNE)', 'audio(DNE)']);

    // The refused tracks are retried with backoff on the fresh session.
    r.published.media = true;
    const mediaAt = performance.now();
    await sleep(1_500);
    expect(reestablished.subs.slice(-2)).toEqual(['video', 'audio']);
    expect(objectsSince(mediaAt)).toBeGreaterThan(0);
    expect(r.sessions).toHaveLength(3);
    expect(errors.filter((e) => e.severity === 'fatal')).toEqual([]);
    await player.destroy();
  }, 10_000);

  it('falls back to a fresh session when the in-session resume delivers no media', async () => {
    NamespaceFollower.RESUME_BOUND_MS = 200;
    const r = relay({ refusalDelayMs: 0 });
    stop = () => r.stop();
    const { player, objectsSince } = await startPlaying(r);

    await r.endPublisher();
    await sleep(100);
    r.published.media = true;
    r.published.objects = false;
    await r.republish();
    await sleep(100);
    expect(r.sessions[0]!.subs).toEqual(['catalog', 'video', 'audio', 'video', 'audio']);
    expect(r.sessions).toHaveLength(1);

    await sleep(200);
    expect(r.sessions).toHaveLength(2);
    expect(r.sessions[1]!.subs).toEqual(['catalog', 'video', 'audio']);
    r.published.objects = true;
    const at = performance.now();
    await sleep(100);
    expect(objectsSince(at)).toBeGreaterThan(0);
    await player.destroy();
  }, 10_000);

  it('a namespace flapping quickly does not storm the relay', async () => {
    const r = relay({ refusalDelayMs: 0 });
    stop = () => r.stop();
    const { player, errors } = await startPlaying(r);

    // The media stays unpublished while the namespace flaps for about a second.
    await r.endPublisher();
    await sleep(50);
    for (let i = 0; i < 20; i++) {
      await r.republish();
      await sleep(25);
      await r.withdraw();
      await sleep(25);
    }
    await r.republish();
    await sleep(200);

    // One in-session resume, refused, and one fresh session; further returns
    // wait out the spacing guards. The fresh session's refused tracks retry
    // with backoff.
    expect(r.sessions[0]!.subs).toEqual(['catalog', 'video', 'audio', 'video(DNE)', 'audio(DNE)']);
    expect(r.sessions).toHaveLength(2);
    expect(r.sessions[1]!.subs.length).toBeLessThanOrEqual(7);
    expect(errors.filter((e) => e.severity === 'fatal')).toEqual([]);
    await player.destroy();
  }, 10_000);
});
