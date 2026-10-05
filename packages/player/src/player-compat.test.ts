/**
 * Opt-in compat behaviours for non-conformant relays.
 *
 * @module
 */

import { describe, it, expect, vi } from 'vitest';
import { MoqtPlayer } from './player.js';
import type { MoqtPlayerConfig, PlayerCompat } from './config.js';
import type { MoqtConnection } from '@moqt/webtransport';
import type { ControlMessage, MoqtObject } from '@moqt/transport';
import { varint } from '@moqt/transport';

function createMockAdapter() {
  let nextRequestId = 1n;
  const adapter: any = {
    session: { state: 'established', close: vi.fn(() => []) },
    draftVersion: 16,
    onMessage: null, onClose: null, onError: null, onDataStream: null, onObject: null,
    onStreamClosed: null, onDatagram: null, onNamespaceMessage: null, onQlogEvent: null,
    _connectResolve: null as (() => void) | null,
    connect: vi.fn(() => new Promise<void>((resolve) => { adapter._connectResolve = resolve; })),
    subscribe: vi.fn(async () => varint(nextRequestId++)),
    requestUpdate: vi.fn(async () => varint(nextRequestId++)),
    unsubscribe: vi.fn(async () => {}),
    fetch: vi.fn(async () => varint(nextRequestId++)),
    fetchCancel: vi.fn(async () => {}),
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
      renderGroup: 1, codec: 'avc1.42001f', width: 1280, height: 720, bitrate: 2_000_000,
    },
  ],
});

const VIDEO_ALIAS = 50n;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function startWithVideo(compat?: readonly PlayerCompat[]) {
  const adapter = createMockAdapter();
  const config: MoqtPlayerConfig = {
    url: 'https://relay.example.com/moq',
    namespace: 'live/broadcast',
    createTransport: vi.fn(async () => ({}) as any),
    createConnection: () => adapter as unknown as MoqtConnection,
    catalogBootstrap: 'subscribe',
    ...(compat ? { compat } : {}),
  };
  const player = new MoqtPlayer(config);
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
  adapter._triggerMessage({
    type: 'SUBSCRIBE_OK', requestId: videoReqId, trackAlias: varint(VIDEO_ALIAS),
    parameters: new Map(), trackExtensions: [],
  } as unknown as ControlMessage);
  return { player, adapter };
}

function emptyVideoObject(adapter: ReturnType<typeof createMockAdapter>): void {
  adapter._triggerObject(0n, {
    kind: 'data', trackAlias: varint(VIDEO_ALIAS), groupId: varint(3), subgroupId: varint(0),
    objectId: varint(1), payload: new Uint8Array(0),
  } as MoqtObject);
}

describe('compat empty-objects', () => {
  it('skips and counts an empty Normal media object', async () => {
    const { player, adapter } = await startWithVideo(['empty-objects']);
    emptyVideoObject(adapter);
    emptyVideoObject(adapter);
    expect(player.emptyMediaObjectsSkipped).toBe(2);
  });

  it('is off unless configured', async () => {
    const { player, adapter } = await startWithVideo();
    emptyVideoObject(adapter);
    expect(player.emptyMediaObjectsSkipped).toBe(0);
  });
});
