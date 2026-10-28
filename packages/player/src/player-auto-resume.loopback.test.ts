/**
 * autoResume: whether media recovers while the page is hidden. The relay
 * restart case drives a real player and real draft-18 connections over the
 * in-memory loopback, one server endpoint per session the player opens; the
 * resubscribe and liveness holds are checked on the player directly.
 *
 * Uses an internal relative testkit import by design — the testkit is not a
 * published export of @openmoq/webtransport.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { varint } from '@openmoq/transport';
import { createLoopback } from '../../webtransport/src/testkit/loopback.js';
import { MoqtConnection } from '../../webtransport/src/adapter.js';
import { MoqtPlayer } from './player.js';
import { NamespaceFollower } from './namespace-follow.js';
import { PlayerState } from './state.js';

const enc = (o: unknown) => new TextEncoder().encode(JSON.stringify(o));
const td = new TextDecoder();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const CATALOG = {
  version: 'draft-01',
  tracks: [
    { name: 'video', packaging: 'loc', renderGroup: 1, isLive: true, role: 'video',
      codec: 'av01.0.08M.10', width: 1920, height: 1080, bitrate: 1_500_000 },
    { name: 'audio', packaging: 'loc', renderGroup: 1, isLive: true, role: 'audio',
      codec: 'opus', samplerate: 48000, channelConfig: '2', bitrate: 32_000 },
  ],
};

/** A DOM document stand-in whose visibility the test sets. */
class FakeDocument extends EventTarget {
  visibilityState: 'visible' | 'hidden' = 'visible';
  setHidden(hidden: boolean): void {
    this.visibilityState = hidden ? 'hidden' : 'visible';
    this.dispatchEvent(new Event('visibilitychange'));
  }
}

interface Session { server: MoqtConnection; subs: string[]; nsRequestId: bigint | null }

/** A relay whose publisher can go away and return. */
function relay() {
  let published = true;
  const sessions: Session[] = [];
  let alias = 40n;
  const wire = (s: Session): void => {
    const { server } = s;
    server.onSubscribe = (requestId, _ns, trackName) => {
      const name = td.decode(trackName);
      s.subs.push(published ? name : `${name}(DNE)`);
      void (async () => {
        if (!published) {
          await sleep(20);
          await server.rejectSubscribe(requestId, 0x10n, 'track does not exist');
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
        if (published) await server.sendNamespace(requestId, []);
      })();
    };
  };
  return {
    sessions,
    createTransport: async () => {
      const { a, b } = createLoopback({});
      const s: Session = { server: new MoqtConnection(18, { role: 'server' }), subs: [], nsRequestId: null };
      wire(s);
      sessions.push(s);
      void s.server.connect(b, {});
      return a as never;
    },
    async restart(): Promise<void> {
      published = false;
      await sessions[sessions.length - 1]!.server.close(varint(0n), 'relay restart');
    },
    async republish(): Promise<void> {
      published = true;
      for (const s of sessions) {
        if (s.nsRequestId !== null) await s.server.sendNamespace(s.nsRequestId, []).catch(() => {});
      }
    },
  };
}

/** Play, restart the relay while hidden, and let the publisher return. */
async function restartWhileHidden(doc: FakeDocument, autoResume?: boolean) {
  const r = relay();
  const player = new MoqtPlayer({
    url: 'https://unused.example/moq',
    namespace: 'live/broadcast',
    draftVersion: 18,
    followNamespace: true,
    ...(autoResume !== undefined ? { autoResume } : {}),
    createConnection: () => new MoqtConnection(18) as never,
    createTransport: r.createTransport,
  });
  await player.load();
  await sleep(20);
  player.play();
  doc.setHidden(true);
  await r.restart();
  await sleep(200);
  await r.republish();
  await sleep(300);
  return { r, player };
}

const RECONNECT_DELAYS_MS = (MoqtPlayer as unknown as { RECONNECT_DELAYS_MS: number[] }).RECONNECT_DELAYS_MS;
const SETTLE_MS = NamespaceFollower.RETURN_SETTLE_MS;

describe('autoResume', () => {
  let doc: FakeDocument;
  beforeEach(() => {
    doc = new FakeDocument();
    vi.stubGlobal('document', doc);
    (MoqtPlayer as unknown as { RECONNECT_DELAYS_MS: number[] }).RECONNECT_DELAYS_MS = [10, 20, 40];
    NamespaceFollower.RETURN_SETTLE_MS = 20;
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    (MoqtPlayer as unknown as { RECONNECT_DELAYS_MS: number[] }).RECONNECT_DELAYS_MS = RECONNECT_DELAYS_MS;
    NamespaceFollower.RETURN_SETTLE_MS = SETTLE_MS;
  });

  it('rejects a non-boolean value', () => {
    expect(() => new MoqtPlayer({ url: 'https://x/moq', namespace: 'n', autoResume: 1 as never }))
      .toThrow(/autoResume must be a boolean/);
  });

  describe('relay restart while the page is hidden', () => {
    it('by default subscribes media on the re-established session while hidden', async () => {
      const { r, player } = await restartWhileHidden(doc);
      expect(r.sessions.map((s) => s.subs)).toEqual([
        ['catalog', 'video', 'audio'], ['catalog(DNE)'], ['catalog', 'video', 'audio'],
      ]);
      await player.destroy();
    }, 10_000);

    it('off: holds media while hidden, then subscribes on the same session once visible', async () => {
      const { r, player } = await restartWhileHidden(doc, false);
      expect(r.sessions[2]!.subs).toEqual(['catalog']);

      doc.setHidden(false);
      await sleep(100);
      expect(r.sessions).toHaveLength(3);
      expect(r.sessions[2]!.subs).toEqual(['catalog', 'video', 'audio']);
      expect(player.state).toBe(PlayerState.PLAYING);
      await player.destroy();
    }, 10_000);
  });

  describe('holds while hidden', () => {
    function hiddenPlayer(autoResume?: boolean) {
      doc.setHidden(true);
      return new MoqtPlayer({
        url: 'https://unused.example/moq', namespace: 'live/broadcast',
        ...(autoResume !== undefined ? { autoResume } : {}),
      }) as unknown as {
        connection: unknown;
        activeSubscriptions: Map<bigint, unknown>;
        stateMachine: { transition: (to: string) => void };
        replaceSubscription: (name: string) => void;
        scheduleResubscribe: (name: string, cause: string) => void;
        livenessHoldWhileHidden: (track: unknown, restart: object) => Promise<boolean>;
        destroy: () => Promise<void>;
      };
    }

    it('a resubscribe runs while hidden by default', async () => {
      const p = hiddenPlayer();
      p.connection = {};
      const replace = vi.fn();
      p.replaceSubscription = replace;
      p.scheduleResubscribe('video', 'publish_done');
      expect(replace).toHaveBeenCalledOnce();
      await p.destroy();
    });

    it('off: a resubscribe waits for the page to be visible', async () => {
      const p = hiddenPlayer(false);
      p.connection = {};
      const replace = vi.fn();
      p.replaceSubscription = replace;
      p.scheduleResubscribe('video', 'publish_done');
      await sleep(1_100);
      expect(replace).not.toHaveBeenCalled();
      doc.setHidden(false);
      await sleep(1_100);
      expect(replace).toHaveBeenCalledOnce();
      await p.destroy();
    }, 5_000);

    it('the liveness restart is held while hidden only when off', async () => {
      const track = { trackName: 'video', mediaType: 'video' };
      const restart = { attempts: 0, cancelled: false };

      const byDefault = hiddenPlayer();
      byDefault.stateMachine.transition(PlayerState.LOADING);
      byDefault.stateMachine.transition(PlayerState.PLAYING);
      expect(await byDefault.livenessHoldWhileHidden(track, restart)).toBe(false);

      const off = hiddenPlayer(false);
      off.stateMachine.transition(PlayerState.LOADING);
      off.stateMachine.transition(PlayerState.PLAYING);
      let settled = false;
      void off.livenessHoldWhileHidden(track, restart).then(() => { settled = true; });
      await sleep(600);
      expect(settled).toBe(false);
      doc.setHidden(false);
      await vi.waitFor(() => expect(settled).toBe(true), { timeout: 4_000 });
      await byDefault.destroy();
      await off.destroy();
    }, 10_000);
  });
});
