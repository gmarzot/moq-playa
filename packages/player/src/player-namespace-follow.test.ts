/**
 * followNamespace: SUBSCRIBE_NAMESPACE state reporting, and resuming or
 * re-establishing the session when the namespace is published again after
 * going away, including before the first catalog.
 *
 * @see draft-ietf-moq-transport-18 §10.18
 * @module
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MoqtPlayer } from './player.js';
import { NamespaceFollower } from './namespace-follow.js';
import { PlayerState } from './state.js';
import { PlayerErrorCode } from './errors.js';
import type { MoqtPlayerConfig } from './config.js';
import type { NamespaceState } from './events.js';
import type { MoqtConnection } from '@openmoq/webtransport';
import type { ControlMessage, MoqtObject } from '@openmoq/transport';
import { varint } from '@openmoq/transport';

function createMockAdapter() {
  let nextRequestId = 1n;
  const adapter: any = {
    session: { state: 'established', close: vi.fn(() => []) },
    draftVersion: 18,
    onMessage: null, onClose: null, onError: null, onDataStream: null, onObject: null,
    onStreamClosed: null, onDatagram: null, onNamespaceMessage: null, onQlogEvent: null,
    _connectResolve: null as (() => void) | null,
    connect: vi.fn(() => new Promise<void>((resolve) => { adapter._connectResolve = resolve; })),
    subscribe: vi.fn(async () => varint(nextRequestId++)),
    requestUpdate: vi.fn(async () => varint(nextRequestId++)),
    unsubscribe: vi.fn(async () => {}),
    fetch: vi.fn(async () => varint(nextRequestId++)),
    fetchCancel: vi.fn(async () => {}),
    trackStatus: vi.fn(async () => varint(nextRequestId++)),
    subscribeNamespace: vi.fn(async () => varint(nextRequestId++)),
    cancelNamespace: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    _triggerMessage: (msg: ControlMessage) => adapter.onMessage?.(msg),
    _triggerObject: (streamId: bigint, obj: MoqtObject) => adapter.onObject?.(streamId, obj),
  };
  return adapter;
}

const CATALOG_JSON = JSON.stringify({
  version: 1,
  tracks: [
    {
      name: 'video', packaging: 'loc', isLive: true, role: 'video',
      renderGroup: 1, codec: 'av01.0.08M.10', width: 1920, height: 1080, bitrate: 1_500_000,
    },
    {
      name: 'audio', packaging: 'loc', isLive: true, role: 'audio',
      renderGroup: 1, codec: 'opus', samplerate: 48000, channelConfig: '2', bitrate: 32000,
    },
  ],
});

const VIDEO_ALIAS = 50n;
const AUDIO_ALIAS = 51n;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const SETTLE_MS = NamespaceFollower.RETURN_SETTLE_MS;
const RESUME_BOUND_MS = NamespaceFollower.RESUME_BOUND_MS;

/**
 * Load and play with followNamespace on, recording namespace states from the
 * start. `videoRefused` answers the video SUBSCRIBE with DOES_NOT_EXIST.
 */
async function startFollowing(
  adapter: ReturnType<typeof createMockAdapter>,
  opts: { followNamespace?: boolean; videoRefused?: boolean } = {},
) {
  const config: MoqtPlayerConfig = {
    url: 'https://relay.example.com/moq',
    namespace: 'live/broadcast',
    createTransport: vi.fn(async () => ({}) as any),
    createConnection: () => adapter as unknown as MoqtConnection,
    catalogBootstrap: 'subscribe',
    ...(opts.followNamespace === false ? {} : { followNamespace: true }),
  };
  const player = new MoqtPlayer(config);
  const states: NamespaceState[] = [];
  player.on('namespace_state', (e) => states.push(e.state));
  const loadPromise = player.load();
  await vi.waitFor(() => expect(adapter.connect).toHaveBeenCalled());
  adapter._connectResolve?.();
  await loadPromise;

  const catalogReqId = await adapter.subscribe.mock.results[0]?.value;
  adapter._triggerMessage({
    type: 'SUBSCRIBE_OK', requestId: catalogReqId, trackAlias: catalogReqId, parameters: new Map(),
  } as unknown as ControlMessage);
  adapter._triggerObject(0n, {
    kind: 'data', trackAlias: catalogReqId, groupId: varint(0), subgroupId: varint(0),
    objectId: varint(0), payload: new TextEncoder().encode(CATALOG_JSON),
  } as MoqtObject);
  await sleep(0);

  const videoReqId = await adapter.subscribe.mock.results[1]?.value;
  const audioReqId = await adapter.subscribe.mock.results[2]?.value;
  adapter._triggerMessage((opts.videoRefused
    ? {
      type: 'REQUEST_ERROR', requestId: videoReqId, errorCode: varint(0x10n),
      retryInterval: varint(0n), errorReason: 'no such namespace or track',
    }
    : {
      type: 'SUBSCRIBE_OK', requestId: videoReqId, trackAlias: varint(VIDEO_ALIAS),
      parameters: new Map(), trackExtensions: [],
    }) as unknown as ControlMessage);
  adapter._triggerMessage({
    type: 'SUBSCRIBE_OK', requestId: audioReqId, trackAlias: varint(AUDIO_ALIAS),
    parameters: new Map(), trackExtensions: [],
  } as unknown as ControlMessage);

  player.play();
  expect(player.state).toBe(PlayerState.PLAYING);
  const sent = adapter.subscribeNamespace.mock.results[0];
  const nsReqId = sent ? BigInt(await sent.value) : null;
  return { player, states, nsReqId };
}

/** Load with followNamespace and the default catalog bootstrap; no catalog is delivered. */
async function startLoading(
  adapter: ReturnType<typeof createMockAdapter>,
  opts: { followNamespace?: boolean } = {},
) {
  const config: MoqtPlayerConfig = {
    url: 'https://relay.example.com/moq',
    namespace: 'live/broadcast',
    createTransport: vi.fn(async () => ({}) as any),
    createConnection: () => adapter as unknown as MoqtConnection,
    ...(opts.followNamespace === false ? {} : { followNamespace: true }),
  };
  const player = new MoqtPlayer(config);
  const errors: { severity: string; message: string }[] = [];
  player.on('error', (e) => errors.push({ severity: e.error.severity, message: e.error.message }));
  const loadPromise = player.load();
  await vi.waitFor(() => expect(adapter.connect).toHaveBeenCalled());
  adapter._connectResolve?.();
  await loadPromise;
  await sleep(0);
  const sent = adapter.subscribeNamespace.mock.results[0];
  const nsReqId = sent ? BigInt(await sent.value) : null;
  return { player, errors, nsReqId };
}

/** The bootstrap coordinator's subscription-ended failure. */
function catalogSubscriptionEnded(player: MoqtPlayer): void {
  const coord = (player as unknown as { catalogBootstrapCoord: { fatal(r: string, ended: boolean): void } })
    .catalogBootstrapCoord;
  coord.fatal('catalog subscription ended before a base was received', true);
}

function requestOk(adapter: ReturnType<typeof createMockAdapter>, requestId: bigint): void {
  adapter._triggerMessage({
    type: 'REQUEST_OK', requestId: varint(requestId), parameters: new Map(),
  } as unknown as ControlMessage);
}

function namespaceMsg(
  adapter: ReturnType<typeof createMockAdapter>, requestId: bigint, type: 'NAMESPACE' | 'NAMESPACE_DONE',
): void {
  adapter.onNamespaceMessage?.(requestId, { type, trackNamespaceSuffix: [] });
}

function feedVideo(adapter: ReturnType<typeof createMockAdapter>): void {
  adapter._triggerObject(0n, {
    kind: 'data', trackAlias: varint(VIDEO_ALIAS), groupId: varint(0), subgroupId: varint(0),
    objectId: varint(1), payload: new Uint8Array([0xaa]),
  } as MoqtObject);
}

describe('followNamespace (SUBSCRIBE_NAMESPACE, §10.18)', () => {
  beforeEach(() => {
    NamespaceFollower.RETURN_SETTLE_MS = 20;
    NamespaceFollower.RESUME_BOUND_MS = 20;
  });
  afterEach(() => {
    NamespaceFollower.RETURN_SETTLE_MS = SETTLE_MS;
    NamespaceFollower.RESUME_BOUND_MS = RESUME_BOUND_MS;
  });

  it('is off unless configured', async () => {
    const adapter = createMockAdapter();
    const { player } = await startFollowing(adapter, { followNamespace: false });
    expect(adapter.subscribeNamespace).not.toHaveBeenCalled();
    expect(player.namespaceState).toBeNull();
  });

  it('does not follow on a draft-16 session', async () => {
    const adapter = createMockAdapter();
    adapter.draftVersion = 16;
    const { player } = await startFollowing(adapter);
    expect(adapter.subscribeNamespace).not.toHaveBeenCalled();
    expect(player.namespaceState).toBeNull();
  });

  it('reports sent, accepted, published and withdrawn', async () => {
    const adapter = createMockAdapter();
    const { player, states, nsReqId } = await startFollowing(adapter);
    requestOk(adapter, nsReqId!);
    namespaceMsg(adapter, nsReqId!, 'NAMESPACE');
    expect(player.namespaceState).toBe('published');
    vi.spyOn(player, 'migrate').mockResolvedValue();
    namespaceMsg(adapter, nsReqId!, 'NAMESPACE_DONE');
    expect(states).toEqual(['pending', 'listening', 'published', 'withdrawn']);
  });

  it('follows on a draft-22 session too', async () => {
    const adapter = createMockAdapter();
    adapter.draftVersion = 22;
    const { player, states, nsReqId } = await startFollowing(adapter);
    requestOk(adapter, nsReqId!);
    namespaceMsg(adapter, nsReqId!, 'NAMESPACE');
    expect(adapter.subscribeNamespace).toHaveBeenCalledOnce();
    expect(player.namespaceState).toBe('published');
    expect(states).toEqual(['pending', 'listening', 'published']);
  });

  it('a REQUEST_ERROR reports refused', async () => {
    const adapter = createMockAdapter();
    const { player, nsReqId } = await startFollowing(adapter);
    adapter._triggerMessage({
      type: 'REQUEST_ERROR', requestId: varint(nsReqId!), errorCode: varint(0x1n),
      retryInterval: varint(0n), errorReason: 'unauthorized',
    } as unknown as ControlMessage);
    expect(player.namespaceState).toBe('refused');
  });

  it('re-establishes when the namespace returns and media does not resume', async () => {
    const adapter = createMockAdapter();
    const { player, nsReqId } = await startFollowing(adapter);
    requestOk(adapter, nsReqId!);
    namespaceMsg(adapter, nsReqId!, 'NAMESPACE');
    const migrate = vi.spyOn(player, 'migrate').mockResolvedValue();
    await sleep(40);
    expect(migrate).not.toHaveBeenCalled();             // a first NAMESPACE is not a return

    namespaceMsg(adapter, nsReqId!, 'NAMESPACE_DONE');
    namespaceMsg(adapter, nsReqId!, 'NAMESPACE');
    await sleep(60);
    expect(migrate).toHaveBeenCalledTimes(1);
  });

  it('leaves the session alone when media resumes by itself after the return', async () => {
    const adapter = createMockAdapter();
    const { player, nsReqId } = await startFollowing(adapter);
    requestOk(adapter, nsReqId!);
    namespaceMsg(adapter, nsReqId!, 'NAMESPACE');
    const migrate = vi.spyOn(player, 'migrate').mockResolvedValue();
    namespaceMsg(adapter, nsReqId!, 'NAMESPACE_DONE');
    namespaceMsg(adapter, nsReqId!, 'NAMESPACE');
    feedVideo(adapter);
    await sleep(60);
    expect(migrate).not.toHaveBeenCalled();
  });

  it('a track refused as not existing, then the namespace published, re-establishes', async () => {
    const adapter = createMockAdapter();
    const { player, nsReqId } = await startFollowing(adapter, { videoRefused: true });
    requestOk(adapter, nsReqId!);                       // accepted, namespace not yet published
    const migrate = vi.spyOn(player, 'migrate').mockResolvedValue();
    namespaceMsg(adapter, nsReqId!, 'NAMESPACE');
    await sleep(60);
    expect(migrate).toHaveBeenCalledTimes(1);
  });

  describe('the publisher restarting during catalog bootstrap', () => {
    it('waits instead of failing and re-subscribes the catalog after the namespace returned', async () => {
      const adapter = createMockAdapter();
      const { player, errors, nsReqId } = await startLoading(adapter);
      requestOk(adapter, nsReqId!);
      namespaceMsg(adapter, nsReqId!, 'NAMESPACE');
      const migrate = vi.spyOn(player, 'migrate').mockResolvedValue();
      namespaceMsg(adapter, nsReqId!, 'NAMESPACE_DONE');
      namespaceMsg(adapter, nsReqId!, 'NAMESPACE');
      const subscribes = adapter.subscribe.mock.calls.length;
      catalogSubscriptionEnded(player);

      expect(errors.filter((e) => e.severity === 'fatal')).toEqual([]);
      expect(errors.some((e) => e.severity === 'degraded' && /waiting for the publisher/.test(e.message)))
        .toBe(true);
      await sleep(0);
      expect(adapter.subscribe).toHaveBeenCalledTimes(subscribes + 1);
      expect(migrate).not.toHaveBeenCalled();
      // No catalog within RESUME_BOUND_MS: the session is re-established.
      await sleep(60);
      expect(player.state).toBe(PlayerState.LOADING);
      expect(migrate).toHaveBeenCalledTimes(1);
    });

    it('ending while the namespace is withdrawn re-subscribes the catalog on its return', async () => {
      const adapter = createMockAdapter();
      const { player, errors, nsReqId } = await startLoading(adapter);
      requestOk(adapter, nsReqId!);
      namespaceMsg(adapter, nsReqId!, 'NAMESPACE');
      const migrate = vi.spyOn(player, 'migrate').mockResolvedValue();
      namespaceMsg(adapter, nsReqId!, 'NAMESPACE_DONE');
      catalogSubscriptionEnded(player);
      await sleep(60);
      expect(migrate).not.toHaveBeenCalled();

      const subscribes = adapter.subscribe.mock.calls.length;
      namespaceMsg(adapter, nsReqId!, 'NAMESPACE');
      await sleep(0);
      expect(adapter.subscribe).toHaveBeenCalledTimes(subscribes + 1);
      await sleep(60);
      expect(migrate).toHaveBeenCalledTimes(1);
      expect(errors.filter((e) => e.severity === 'fatal')).toEqual([]);
    });

    it('a catalog SUBSCRIBE refused as not existing waits for the publisher, with no retry timer', async () => {
      const adapter = createMockAdapter();
      const { player, errors, nsReqId } = await startLoading(adapter);
      requestOk(adapter, nsReqId!);
      const migrate = vi.spyOn(player, 'migrate').mockResolvedValue();
      const catalogReqId = await adapter.subscribe.mock.results[0]?.value;
      adapter._triggerMessage({
        type: 'REQUEST_ERROR', requestId: catalogReqId, errorCode: varint(0x10n),
        retryInterval: varint(2n), errorReason: 'no such track',
      } as unknown as ControlMessage);
      expect(errors.some((e) => e.severity === 'degraded' && /waiting for the publisher/.test(e.message))).toBe(true);
      expect((player as unknown as { catalogSubscribeRetryTimer: unknown }).catalogSubscribeRetryTimer).toBeNull();

      namespaceMsg(adapter, nsReqId!, 'NAMESPACE');
      await sleep(0);
      expect(adapter.subscribe).toHaveBeenCalledTimes(2);
      const retryReqId = await adapter.subscribe.mock.results[1]?.value;
      // Refused again: the session is re-established at once.
      adapter._triggerMessage({
        type: 'REQUEST_ERROR', requestId: retryReqId, errorCode: varint(0x10n),
        retryInterval: varint(2n), errorReason: 'no such track',
      } as unknown as ControlMessage);
      await sleep(5);
      expect(migrate).toHaveBeenCalledTimes(1);
      expect(errors.filter((e) => e.severity === 'fatal')).toEqual([]);
    });

    it('a catalog SUBSCRIBE refused for any other reason is fatal', async () => {
      const adapter = createMockAdapter();
      const { errors, nsReqId } = await startLoading(adapter);
      requestOk(adapter, nsReqId!);
      const catalogReqId = await adapter.subscribe.mock.results[0]?.value;
      adapter._triggerMessage({
        type: 'REQUEST_ERROR', requestId: catalogReqId, errorCode: varint(0x1n),
        retryInterval: varint(0n), errorReason: 'unauthorized',
      } as unknown as ControlMessage);
      expect(errors.some((e) => e.severity === 'fatal' && /catalog SUBSCRIBE refused: unauthorized/.test(e.message))).toBe(true);
    });

    it('is fatal without followNamespace', async () => {
      const adapter = createMockAdapter();
      const { player, errors } = await startLoading(adapter, { followNamespace: false });
      const migrate = vi.spyOn(player, 'migrate').mockResolvedValue();
      catalogSubscriptionEnded(player);
      expect(errors.some((e) => e.severity === 'fatal' && /catalog bootstrap failed/.test(e.message))).toBe(true);
      await sleep(60);
      expect(migrate).not.toHaveBeenCalled();
    });
  });

  describe('a listed track refused as not existing', () => {
    const td = new TextDecoder();
    const names = (adapter: ReturnType<typeof createMockAdapter>): string[] =>
      adapter.subscribe.mock.calls.map((c: unknown[]) => td.decode(c[1] as Uint8Array));
    const lastRequestId = async (adapter: ReturnType<typeof createMockAdapter>, name: string): Promise<bigint> =>
      BigInt(await adapter.subscribe.mock.results[names(adapter).lastIndexOf(name)]!.value);
    const refuse = (adapter: ReturnType<typeof createMockAdapter>, requestId: bigint): void =>
      adapter._triggerMessage({
        type: 'REQUEST_ERROR', requestId: varint(requestId), errorCode: varint(0x10n),
        retryInterval: varint(0n), errorReason: 'track does not exist',
      } as unknown as ControlMessage);
    const accept = (adapter: ReturnType<typeof createMockAdapter>, requestId: bigint, alias: bigint): void =>
      adapter._triggerMessage({
        type: 'SUBSCRIBE_OK', requestId: varint(requestId), trackAlias: varint(alias),
        parameters: new Map(), trackExtensions: [],
      } as unknown as ControlMessage);
    const trackEnded = (adapter: ReturnType<typeof createMockAdapter>, requestId: bigint): void =>
      adapter._triggerMessage({
        type: 'PUBLISH_DONE', requestId: varint(requestId), statusCode: varint(0x2),
        streamCount: varint(0), errorReason: 'track ended',
      } as unknown as ControlMessage);

    /** Playing with the namespace published; video then ends, and audio unless `audioPlays`. */
    async function tracksEnded(opts: { followNamespace?: boolean; audioPlays?: boolean } = {}) {
      const adapter = createMockAdapter();
      const { player, nsReqId } = await startFollowing(adapter, opts);
      if (nsReqId !== null) {
        requestOk(adapter, nsReqId);
        namespaceMsg(adapter, nsReqId, 'NAMESPACE');
      }
      const refusals: string[] = [];
      player.on('error', (e) => {
        if (e.error.code === PlayerErrorCode.SUBSCRIPTION_REFUSED) refusals.push(e.error.message);
      });
      trackEnded(adapter, await lastRequestId(adapter, 'video'));
      if (!opts.audioPlays) trackEnded(adapter, await lastRequestId(adapter, 'audio'));
      const p = player as unknown as {
        replaceSubscription(name: string, cause: string): void;
        cancelResubscribe(name: string): void;
        publishDoneRetries: Map<string, { timer: unknown }>;
        livenessRestarts: Map<string, { attempts: number; active: boolean; cancelled: boolean }>;
      };
      /** Subscribe to `name` now and refuse it, as the relay does while the track is missing. */
      const subscribeRefused = async (name: string): Promise<void> => {
        p.cancelResubscribe(name);
        p.replaceSubscription(name, 'liveness');
        await sleep(0);
        refuse(adapter, await lastRequestId(adapter, name));
      };
      return { adapter, player, nsReqId, refusals, p, subscribeRefused };
    }

    it('is reported once until the track is subscribed again', async () => {
      const { adapter, player, refusals, p, subscribeRefused } = await tracksEnded();
      const failed: string[] = [];
      player.on('track_subscribe_failed', (e) => failed.push(e.trackName));

      await subscribeRefused('video');
      await subscribeRefused('video');
      expect(failed).toEqual(['video', 'video']);
      expect(refusals).toHaveLength(1);
      expect(refusals[0]).toMatch(/Track "video" refused: .*; retrying in 2 s, backing off to 60 s$/);
      expect(p.publishDoneRetries.get('video')?.timer).not.toBeNull();

      p.cancelResubscribe('video');
      p.replaceSubscription('video', 'refused');
      await sleep(0);
      const videoReqId = await lastRequestId(adapter, 'video');
      accept(adapter, videoReqId, 60n);
      trackEnded(adapter, videoReqId);
      await subscribeRefused('video');
      expect(refusals).toHaveLength(2);
    });

    it('replaces a running liveness ladder', async () => {
      const { refusals, p, subscribeRefused } = await tracksEnded();
      const restart = { attempts: 1, active: true, cancelled: false };
      p.livenessRestarts.set('video:video', restart);
      await subscribeRefused('video');
      expect(restart.cancelled).toBe(true);
      expect(p.publishDoneRetries.get('video')?.timer).not.toBeNull();
      expect(refusals).toHaveLength(1);
    });

    it('without followNamespace, leaves a running liveness ladder to retry', async () => {
      // Audio still plays: the end of every track would reconnect.
      const { refusals, p, subscribeRefused } = await tracksEnded({ followNamespace: false, audioPlays: true });
      const restart = { attempts: 1, active: true, cancelled: false };
      p.livenessRestarts.set('video:video', restart);
      await subscribeRefused('video');
      expect(restart.cancelled).toBe(false);
      expect(p.publishDoneRetries.get('video')).toBeUndefined();
      expect(refusals[0]).toMatch(/\(code=0x10\) reqId=\d+ retryIn=0$/);
    });

    it('waits for a withdrawn namespace to be published again, then re-subscribes at once', async () => {
      const { adapter, player, nsReqId, refusals, p, subscribeRefused } = await tracksEnded();
      vi.spyOn(player, 'migrate').mockResolvedValue();
      namespaceMsg(adapter, nsReqId!, 'NAMESPACE_DONE');
      await subscribeRefused('video');
      await subscribeRefused('audio');
      expect(refusals).toHaveLength(2);
      expect(refusals.every((m) => m.endsWith('; waiting for the namespace to be published again'))).toBe(true);
      expect(p.publishDoneRetries.get('video')?.timer ?? null).toBeNull();
      expect(p.publishDoneRetries.get('audio')?.timer ?? null).toBeNull();

      const before = names(adapter).length;
      namespaceMsg(adapter, nsReqId!, 'NAMESPACE');
      await sleep(0);
      expect(names(adapter).slice(before)).toEqual(['video', 'audio']);
    });
  });

  describe('refused-track backoff', () => {
    afterEach(() => { vi.useRealTimers(); });

    it('doubles from 2 s to 60 s and starts over on a new session', async () => {
      vi.useFakeTimers();
      const p = new MoqtPlayer({ url: 'https://relay.example.com/moq', namespace: 'live/broadcast' }) as unknown as {
        connection: unknown;
        replaceSubscription: (name: string) => void;
        scheduleResubscribe: (name: string, cause: string) => void;
        destroy: () => Promise<void>;
      };
      p.connection = {};
      const replace = vi.fn();
      p.replaceSubscription = replace;
      /** Refused again: the wait until the next attempt. */
      const nextGap = async (): Promise<number> => {
        const start = Date.now();
        const calls = replace.mock.calls.length;
        p.scheduleResubscribe('video', 'refused');
        while (replace.mock.calls.length === calls) await vi.advanceTimersByTimeAsync(1_000);
        return Date.now() - start;
      };
      const gaps: number[] = [];
      for (let i = 0; i < 7; i++) gaps.push(await nextGap());
      expect(gaps).toEqual([2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000]);
      p.connection = {};
      expect(await nextGap()).toBe(2_000);
      await p.destroy();
    });
  });
});
