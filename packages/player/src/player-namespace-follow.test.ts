/**
 * followNamespace: SUBSCRIBE_NAMESPACE state reporting, and re-establishing the
 * session when the namespace is published again after going away, including
 * before the first catalog.
 *
 * @see draft-ietf-moq-transport-18 §10.18
 * @module
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MoqtPlayer } from './player.js';
import { PlayerState } from './state.js';
import type { MoqtPlayerConfig } from './config.js';
import type { NamespaceState } from './events.js';
import type { MoqtConnection } from '@moqt/webtransport';
import type { ControlMessage, MoqtObject } from '@moqt/transport';
import { varint } from '@moqt/transport';

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
const statics = MoqtPlayer as unknown as { NAMESPACE_RETURN_SETTLE_MS: number };
const SETTLE_MS = statics.NAMESPACE_RETURN_SETTLE_MS;

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
  beforeEach(() => { statics.NAMESPACE_RETURN_SETTLE_MS = 20; });
  afterEach(() => { statics.NAMESPACE_RETURN_SETTLE_MS = SETTLE_MS; });

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
    it('waits instead of failing and re-establishes after the namespace returned', async () => {
      const adapter = createMockAdapter();
      const { player, errors, nsReqId } = await startLoading(adapter);
      requestOk(adapter, nsReqId!);
      namespaceMsg(adapter, nsReqId!, 'NAMESPACE');
      const migrate = vi.spyOn(player, 'migrate').mockResolvedValue();
      namespaceMsg(adapter, nsReqId!, 'NAMESPACE_DONE');
      namespaceMsg(adapter, nsReqId!, 'NAMESPACE');
      catalogSubscriptionEnded(player);

      expect(errors.filter((e) => e.severity === 'fatal')).toEqual([]);
      expect(errors.some((e) => e.severity === 'degraded' && /waiting for the publisher/.test(e.message)))
        .toBe(true);
      await sleep(60);
      expect(player.state).toBe(PlayerState.LOADING);
      expect(migrate).toHaveBeenCalledTimes(1);
    });

    it('ending while the namespace is withdrawn re-establishes on its return', async () => {
      const adapter = createMockAdapter();
      const { player, errors, nsReqId } = await startLoading(adapter);
      requestOk(adapter, nsReqId!);
      namespaceMsg(adapter, nsReqId!, 'NAMESPACE');
      const migrate = vi.spyOn(player, 'migrate').mockResolvedValue();
      namespaceMsg(adapter, nsReqId!, 'NAMESPACE_DONE');
      catalogSubscriptionEnded(player);
      await sleep(60);
      expect(migrate).not.toHaveBeenCalled();

      namespaceMsg(adapter, nsReqId!, 'NAMESPACE');
      await sleep(60);
      expect(migrate).toHaveBeenCalledTimes(1);
      expect(errors.filter((e) => e.severity === 'fatal')).toEqual([]);
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
});
