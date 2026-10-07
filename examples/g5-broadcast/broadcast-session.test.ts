import { describe, it, expect, vi } from 'vitest';
import { BroadcastSession } from './broadcast-session.js';
import type { BroadcastSessionConnection, CarriedCatalog } from './broadcast-session.js';
import type { Fetch } from '@moqt/transport';
import { buildCatalogPayload } from './catalog-publisher.js';
import type { BroadcastCatalogParams } from './catalog-publisher.js';

const wrapInt = (n: bigint) => n;

const CATALOG: BroadcastCatalogParams = {
  videoCodec: 'avc1.42001f',
  width: 1280,
  height: 720,
  fps: 30,
  videoBitrate: 2_000_000,
  targetLatencyMs: 200,
  audio: { sampleRate: 48_000, channels: 1 },
};

function recordingConnection() {
  const calls: string[] = [];
  const accepted: bigint[] = [];
  const sends: Uint8Array[] = [];
  /** Group ID of every subgroup opened. */
  const groups: bigint[] = [];
  const fetchOk: Array<{ group: bigint; object: bigint } | undefined> = [];
  const fetchErrors: Array<{ code: bigint; reason: string }> = [];
  const fetchObjects: Array<{ groupId: bigint; objectId: bigint; payload: Uint8Array }> = [];
  /** LARGEST_OBJECT of each SUBSCRIBE_OK, or undefined when it carried none. */
  const largests: Array<{ group: bigint; object: bigint } | undefined> = [];
  /** Joining Location per subscription request, as the adapter would have saved it. */
  const joiningLocations = new Map<bigint, { group: bigint; object: bigint }>();
  /** [requestId, statusCode] of every PUBLISH_DONE. */
  const dones: Array<[bigint, bigint]> = [];
  let nextStream = 100n;
  const recorded = {
    calls, accepted, sends, groups, fetchOk, fetchErrors, fetchObjects, largests, joiningLocations, dones,
  };
  const conn: BroadcastSessionConnection & typeof recorded = {
    ...recorded,
    acceptSubscribe: async (requestId, alias, options) => {
      calls.push('acceptSubscribe');
      accepted.push(alias as bigint);
      const largest = options?.parameters?.get(0x09n)?.[0] as { group: bigint; object: bigint } | undefined;
      largests.push(largest);
      if (largest) joiningLocations.set(requestId as bigint, largest);
    },
    rejectSubscribe: async () => { calls.push('rejectSubscribe'); },
    openSubgroup: async (_alias, groupId) => {
      calls.push('openSubgroup');
      groups.push(groupId as bigint);
      return nextStream++;
    },
    sendObject: async (_sid, _oid, payload) => { calls.push('sendObject'); sends.push(payload); },
    closeSubgroup: async () => { calls.push('closeSubgroup'); },
    publishDone: async (requestId, statusCode) => {
      calls.push('publishDone');
      dones.push([requestId as bigint, statusCode as bigint]);
    },
    close: async () => { calls.push('close'); },
    acceptFetch: async (_rid, options) => { calls.push('acceptFetch'); fetchOk.push(options?.endLocation); },
    rejectFetch: async (_rid, code, reason) => { calls.push('rejectFetch'); fetchErrors.push({ code, reason }); },
    openFetchStream: async () => { calls.push('openFetchStream'); return nextStream++; },
    sendFetchObject: async (_sid, { groupId, objectId, payload }) => {
      calls.push('sendFetchObject');
      fetchObjects.push({ groupId, objectId, payload });
    },
    sendFetchEndOfRange: async (_sid, nonExistent, groupId, objectId) => {
      calls.push(`endOfRange ${nonExistent ? 'none' : 'unknown'} ${groupId}/${objectId}`);
    },
    closeFetchStream: async () => { calls.push('closeFetchStream'); },
    resolveJoiningFetch: (requestId) => {
      // The fake keys the join on the FETCH's own request ID: tests use the subscription's.
      const jl = joiningLocations.get(requestId);
      if (!jl) throw new Error(`subscription ${requestId} has no saved Joining Location`);
      return { startLocation: { group: jl.group, object: 0n }, endLocation: { group: jl.group, object: jl.object + 1n } };
    },
  };
  return conn;
}

function makeSession(conn: BroadcastSessionConnection, hooks: {
  onCatalogPublished?: (bytes: number) => void;
  onSessionClosed?: (error?: number, reason?: string) => void;
  catalog?: BroadcastCatalogParams;
  shutdownGraceMs?: number;
  catalogIntervalMs?: number;
  catalogReady?: () => Promise<void>;
} = {}) {
  const { catalog, shutdownGraceMs, catalogIntervalMs, ...rest } = hooks;
  return new BroadcastSession(conn, {
    catalog: catalog ?? CATALOG,
    publisher: { wrapInt, draft: 16 },
    log: () => {},
    // Off unless a test asks: an interval would outlive every other case.
    catalogIntervalMs: catalogIntervalMs ?? 0,
    ...(shutdownGraceMs !== undefined ? { shutdownGraceMs } : {}),
    ...rest,
  });
}

async function settle() { await new Promise((r) => setTimeout(r, 0)); }

describe('BroadcastSession — subscription routing', () => {
  it('serves catalog/video/audio on ITS connection with a per-generation alias space, rejects unknown tracks', async () => {
    const conn = recordingConnection();
    const published: number[] = [];
    const session = makeSession(conn, { onCatalogPublished: (b) => published.push(b) });

    session.handleSubscribe(1n, 'catalog');
    session.handleSubscribe(3n, 'video');
    session.handleSubscribe(5n, 'audio');
    session.handleSubscribe(7n, 'bogus');
    await settle();

    expect(conn.accepted).toEqual([1n, 2n, 3n]); // fresh allocator: 1, 2, 3
    expect(conn.calls.filter((c) => c === 'rejectSubscribe')).toHaveLength(1);
    expect(published).toHaveLength(1);
    expect(conn.sends).toHaveLength(1); // the catalog object

    // The media aliases actually bound: publication reaches the connection.
    session.publisher.publishVideo(new Uint8Array([1]), { isKeyframe: true, timestampUs: 1 });
    session.publisher.publishAudio(new Uint8Array([2]), { timestampUs: 2 });
    await settle();
    expect(conn.sends.length).toBeGreaterThanOrEqual(3);
  });
});

describe('BroadcastSession — catalog readiness', () => {
  it('a catalog SUBSCRIBE waits until the catalog is ready, then is served', async () => {
    const conn = recordingConnection();
    let ready!: () => void;
    const gate = new Promise<void>((resolve) => { ready = resolve; });
    const session = makeSession(conn, { catalogReady: () => gate });
    session.handleSubscribe(1n, 'catalog');
    await settle();
    expect(conn.calls).not.toContain('acceptSubscribe');

    ready();
    await settle();
    expect(conn.accepted).toEqual([1n]);
    expect(conn.sends).toHaveLength(1);
  });

  it('a catalog that never becomes ready answers the SUBSCRIBE with REQUEST_ERROR', async () => {
    const conn = recordingConnection();
    const session = makeSession(conn, { catalogReady: () => Promise.reject(new Error('no keyframe yet')) });
    session.handleSubscribe(1n, 'catalog');
    await settle();
    expect(conn.calls).toEqual(['rejectSubscribe']);
  });
});

describe('BroadcastSession — generation isolation', () => {
  it('a delayed old-generation onSubscribe is inert after shutdown: no accept, no alias consumed, new session untouched', async () => {
    const connA = recordingConnection();
    const sessionA = makeSession(connA);
    sessionA.handleSubscribe(1n, 'video');
    await settle();
    expect(connA.accepted).toEqual([1n]);
    await sessionA.shutdown();

    const connB = recordingConnection();
    const sessionB = makeSession(connB);

    // The OLD session's relay delivers a late SUBSCRIBE — its handler is
    // bound to session A and must do nothing anywhere.
    const callsABefore = connA.calls.length;
    sessionA.handleSubscribe(3n, 'audio');
    await settle();
    expect(connA.calls.length).toBe(callsABefore); // nothing on the old connection
    expect(connB.calls).toHaveLength(0);           // nothing on the new one either

    // The new generation's allocator was not consumed by the old callback.
    sessionB.handleSubscribe(1n, 'video');
    await settle();
    expect(connB.accepted).toEqual([1n]); // still starts at 1
  });

  it('a delayed old-generation onClose cannot stop the replacement broadcast', async () => {
    const connA = recordingConnection();
    const closedA = vi.fn();
    const sessionA = makeSession(connA, { onSessionClosed: closedA });
    await sessionA.shutdown(); // replaced/stopped

    // The old transport dies afterwards — its onClose fires late.
    sessionA.handleClose(0x3, 'stale close');
    expect(closedA).not.toHaveBeenCalled(); // must not trigger UI/broadcast teardown
  });

  it('a CURRENT generation onClose fires the hook exactly once and retires the publisher', async () => {
    const conn = recordingConnection();
    const closed = vi.fn();
    const session = makeSession(conn, { onSessionClosed: closed });
    session.handleSubscribe(1n, 'video');
    await settle();

    session.handleClose(0x3, 'network gone');
    session.handleClose(0x3, 'network gone'); // duplicate delivery
    expect(closed).toHaveBeenCalledTimes(1);
    expect(closed).toHaveBeenCalledWith(0x3, 'network gone');

    // Publication after the close is inert.
    const sendsBefore = conn.sends.length;
    session.publisher.publishVideo(new Uint8Array([9]), { isKeyframe: true, timestampUs: 9 });
    await settle();
    expect(conn.sends.length).toBe(sendsBefore);
  });

  it('an alias accept resolving AFTER retirement never arms the retired publisher', async () => {
    const conn = recordingConnection();
    let releaseAccept!: () => void;
    conn.acceptSubscribe = () => new Promise((resolve) => { releaseAccept = () => resolve(); });
    const session = makeSession(conn);

    session.handleSubscribe(1n, 'video'); // accept in flight
    await session.shutdown();             // generation retired meanwhile
    releaseAccept();
    await settle();

    session.publisher.publishVideo(new Uint8Array([1]), { isKeyframe: true, timestampUs: 1 });
    await settle();
    expect(conn.sends).toHaveLength(0); // nothing published on the retired generation
    // The guard itself is pinned white-box: the publisher's stopped latch
    // already drops publishes, so the alias slot staying UNBOUND is the only
    // observable proof the retired continuation did not run.
    expect((session.publisher as unknown as { videoAlias: bigint | null }).videoAlias).toBeNull();
  });

  it('shutdown closes the connection BEFORE draining, so a stalled send cannot wedge it', async () => {
    const conn = recordingConnection();
    let rejectSend!: (e: Error) => void;
    conn.sendObject = (_sid, _oid, _payload) => new Promise((_res, rej) => { rejectSend = rej; });
    // Closing the connection rejects the in-flight write — like a real session.
    const realClose = conn.close.bind(conn);
    conn.close = async () => { await realClose(); rejectSend(new Error('connection closed')); };

    const session = makeSession(conn);
    session.handleSubscribe(1n, 'video');
    await settle();
    session.publisher.publishVideo(new Uint8Array([1]), { isKeyframe: true, timestampUs: 1 });
    await settle(); // the send is now stalled

    await expect(session.shutdown()).resolves.toBeUndefined();
    expect(conn.calls).toContain('close');
  });
});

describe('BroadcastSession — audio-less capture', () => {
  it('rejects an audio subscription when the capture has no audio track', async () => {
    const conn = recordingConnection();
    const { audio: _audio, ...noAudio } = CATALOG;
    const session = makeSession(conn, { catalog: noAudio });
    session.handleSubscribe(1n, 'audio');
    await settle();
    expect(conn.calls).toEqual(['rejectSubscribe']); // never accepted
  });
});

describe('BroadcastSession — shutdown transaction', () => {
  it('is single-flight: concurrent shutdowns share one teardown and one connection close', async () => {
    const conn = recordingConnection();
    const session = makeSession(conn);
    const s1 = session.shutdown();
    const s2 = session.shutdown();
    expect(s2).toBe(s1);
    await s1;
    expect(conn.calls.filter((c) => c === 'close')).toHaveLength(1);
  });

  it('a normal stop FINs the active video subgroup BEFORE closing the connection', async () => {
    const conn = recordingConnection();
    const session = makeSession(conn);
    session.handleSubscribe(1n, 'video');
    await settle();
    session.publisher.publishVideo(new Uint8Array([1]), { isKeyframe: true, timestampUs: 1 });
    await settle(); // a subgroup is now open

    await session.shutdown();
    const finIndex = conn.calls.indexOf('closeSubgroup');
    const closeIndex = conn.calls.indexOf('close');
    expect(finIndex).toBeGreaterThanOrEqual(0);   // the subgroup got its FIN
    expect(closeIndex).toBeGreaterThan(finIndex); // graceful: FIN precedes close
  });

  it('a permanently stalled send still terminates within the grace bound (hard-close unblocks it)', async () => {
    const conn = recordingConnection();
    let rejectSend!: (e: Error) => void;
    conn.sendObject = () => new Promise((_res, rej) => { rejectSend = rej; });
    const realClose = conn.close.bind(conn);
    conn.close = async () => { await realClose(); rejectSend(new Error('connection closed')); };

    const session = makeSession(conn, { shutdownGraceMs: 30 });
    session.handleSubscribe(1n, 'video');
    await settle();
    session.publisher.publishVideo(new Uint8Array([1]), { isKeyframe: true, timestampUs: 1 });
    await settle(); // the send is stalled forever

    const start = Date.now();
    await session.shutdown();
    expect(Date.now() - start).toBeLessThan(1000); // bounded, not wedged
    expect(conn.calls).toContain('close');
  });

  it('shutdown accounts for in-flight catalog publication (session-owned work)', async () => {
    const conn = recordingConnection();
    let releaseCatalogSend!: () => void;
    conn.sendObject = (_sid, _oid, _payload) =>
      new Promise((resolve) => { releaseCatalogSend = () => resolve(); });

    const session = makeSession(conn, { shutdownGraceMs: 5000 });
    session.handleSubscribe(1n, 'catalog'); // catalog send now in flight
    await settle();

    let done = false;
    const shutdownPromise = session.shutdown().then(() => { done = true; });
    await settle();
    expect(done).toBe(false); // waits for the tracked catalog work

    releaseCatalogSend();
    await shutdownPromise;
    expect(conn.calls).toContain('closeSubgroup'); // catalog stream closed
  });

  it('a catalog completion landing after retirement cannot touch a replacement (stale hook suppressed)', async () => {
    const conn = recordingConnection();
    let releaseCatalogSend!: () => void;
    conn.sendObject = (_sid, _oid, _payload) =>
      new Promise((resolve) => { releaseCatalogSend = () => resolve(); });
    const published = vi.fn();
    const session = makeSession(conn, { onCatalogPublished: published, shutdownGraceMs: 5000 });
    session.handleSubscribe(1n, 'catalog');
    await settle();

    const shutdownPromise = session.shutdown();
    releaseCatalogSend();
    await shutdownPromise;
    expect(published).not.toHaveBeenCalled(); // retired: no stale UI mutation
  });
});

describe('BroadcastSession — shutdown is genuinely bounded', () => {
  it('a close() that resolves WITHOUT settling a held write still terminates shutdown', async () => {
    // An earlier version of this test made close() reject the stalled send,
    // which proved that assumption rather than the bound. Here close()
    // resolves cleanly and the write NEVER settles — shutdown must still
    // finish.
    const conn = recordingConnection();
    conn.sendObject = () => new Promise<void>(() => { /* never settles, ever */ });
    const session = makeSession(conn, { shutdownGraceMs: 30 });
    session.handleSubscribe(1n, 'video');
    await settle();
    session.publisher.publishVideo(new Uint8Array([1]), { isKeyframe: true, timestampUs: 1 });
    await settle();

    const start = Date.now();
    await expect(session.shutdown()).resolves.toBeUndefined();
    expect(Date.now() - start).toBeLessThan(2000);
    expect(conn.calls).toContain('close'); // close still guaranteed
  });

  it('a close() that never settles is itself bounded — shutdown still resolves', async () => {
    const conn = recordingConnection();
    conn.close = () => new Promise<void>(() => { /* hangs forever */ });
    const session = makeSession(conn, { shutdownGraceMs: 20 });
    const start = Date.now();
    await expect(session.shutdown()).resolves.toBeUndefined();
    expect(Date.now() - start).toBeLessThan(2000);
  });

  it('a throwing logger cannot reject shutdown or skip the connection close', async () => {
    const conn = recordingConnection();
    conn.sendObject = () => new Promise<void>(() => {});
    const session = new BroadcastSession(conn, {
      catalog: CATALOG,
      publisher: { wrapInt, draft: 16 },
      log: () => { throw new Error('logger blew up'); },
      shutdownGraceMs: 20,
    });
    session.handleSubscribe(1n, 'video');
    await settle();
    session.publisher.publishVideo(new Uint8Array([1]), { isKeyframe: true, timestampUs: 1 });
    await settle();
    await expect(session.shutdown()).resolves.toBeUndefined();
    expect(conn.calls).toContain('close');
  });

  it('a REJECTING tracked work item cannot reject shutdown', async () => {
    const conn = recordingConnection();
    // The catalog publication transaction rejects (its terminal path runs).
    conn.openSubgroup = async () => { throw new Error('no streams'); };
    const session = makeSession(conn, { shutdownGraceMs: 200 });
    session.handleSubscribe(1n, 'catalog');
    await settle();
    await expect(session.shutdown()).resolves.toBeUndefined();
  });
});

describe('BroadcastSession — option validation', () => {
  it.each([
    ['videoQueueMax', NaN],
    ['videoQueueMax', Infinity],
    ['videoQueueMax', 0],
    ['videoQueueMax', -1],
    ['videoQueueMax', 1.5],
    ['audioQueueMax', NaN],
    ['audioQueueMax', Infinity],
    ['audioQueueMax', 0],
  ])('rejects a non-positive-integer %s of %s at construction', (key, value) => {
    const conn = recordingConnection();
    expect(() => new BroadcastSession(conn, {
      catalog: CATALOG,
      publisher: { wrapInt, draft: 16, [key]: value } as never,
      log: () => {},
    })).toThrow(/must be a positive integer/i);
  });

  it.each([NaN, Infinity, 0, -5])('rejects an invalid shutdownGraceMs of %s', (value) => {
    const conn = recordingConnection();
    expect(() => new BroadcastSession(conn, {
      catalog: CATALOG,
      publisher: { wrapInt, draft: 16 },
      log: () => {},
      shutdownGraceMs: value,
    })).toThrow(/must be a positive/i);
  });

  it('rejects an unsupported draft rather than silently using draft-16 LOC behavior', () => {
    const conn = recordingConnection();
    expect(() => new BroadcastSession(conn, {
      catalog: CATALOG,
      publisher: { wrapInt, draft: 15 as never },
      log: () => {},
    })).toThrow(/draft/i);
  });
});

describe('BroadcastSession — catalog re-emission (cache refresh)', () => {
  it('keeps publishing catalog groups on the interval', async () => {
    vi.useFakeTimers();
    try {
      const conn = recordingConnection();
      const session = makeSession(conn, { catalogIntervalMs: 50 });

      session.handleSubscribe(1n, 'catalog');
      await vi.advanceTimersByTimeAsync(0);
      const afterFirst = conn.sends.length;
      expect(afterFirst).toBe(1);   // the subscribe-time catalog

      await vi.advanceTimersByTimeAsync(160);
      expect(conn.sends.length).toBeGreaterThan(afterFirst);

      // The timer must not outlive the session.
      const atShutdown = conn.sends.length;
      session.handleClose(0, 'test');
      await vi.advanceTimersByTimeAsync(300);
      expect(conn.sends.length).toBe(atShutdown);
    } finally {
      vi.useRealTimers();
    }
  });

  it('catalogIntervalMs 0 publishes once and starts no timer', async () => {
    vi.useFakeTimers();
    try {
      const conn = recordingConnection();
      const session = makeSession(conn, { catalogIntervalMs: 0 });
      session.handleSubscribe(1n, 'catalog');
      await vi.advanceTimersByTimeAsync(0);
      const once = conn.sends.length;
      await vi.advanceTimersByTimeAsync(500);
      expect(conn.sends.length).toBe(once);
      session.handleClose(0, 'test');
    } finally {
      vi.useRealTimers();
    }
  });
});

function loggedSession(conn: BroadcastSessionConnection, catalogIntervalMs = 0) {
  const lines: string[] = [];
  const session = new BroadcastSession(conn, {
    catalog: CATALOG,
    publisher: { wrapInt, draft: 16 },
    log: (m) => lines.push(m),
    catalogIntervalMs,
  });
  return { session, lines };
}

/** Records the alias of every subgroup the connection opens. */
function recordAliases(conn: ReturnType<typeof recordingConnection>): bigint[] {
  const aliases: bigint[] = [];
  const realOpen = conn.openSubgroup.bind(conn);
  conn.openSubgroup = async (...args: Parameters<typeof realOpen>) => {
    aliases.push(args[0] as bigint);
    return realOpen(...args);
  };
  return aliases;
}

describe('BroadcastSession — subscription ended by the relay', () => {
  it('an ended audio subscription retires the track until a new SUBSCRIBE re-arms it', async () => {
    const conn = recordingConnection();
    const { session, lines } = loggedSession(conn);
    session.handleSubscribe(5n, 'audio');
    await settle();
    expect(session.publisher.audioAliasArmed).toBe(1n);

    session.handleSubscribeClosed(5n);
    expect(lines).toContain('audio: SUBSCRIBE cancelled by the relay (reqId=5)');
    expect(session.publisher.audioAliasArmed).toBeNull();
    expect(session.publisher.endedTracks).toEqual(['audio']);

    session.handleSubscribe(9n, 'audio');
    await settle();
    expect(session.publisher.audioAliasArmed).toBe(2n);
    expect(session.publisher.endedTracks).toEqual([]);
  });

  it('a new catalog SUBSCRIBE moves re-emission to its own alias', async () => {
    vi.useFakeTimers();
    try {
      const conn = recordingConnection();
      const aliases = recordAliases(conn);
      const { session } = loggedSession(conn, 50);
      session.handleSubscribe(1n, 'catalog');           // alias 1
      await vi.advanceTimersByTimeAsync(120);

      session.handleSubscribe(3n, 'catalog');           // alias 2, no close in between
      await vi.advanceTimersByTimeAsync(0);
      const atSwitch = aliases.length;
      await vi.advanceTimersByTimeAsync(160);
      expect(aliases.length).toBeGreaterThan(atSwitch);
      expect(aliases.slice(atSwitch).every((a) => a === 2n)).toBe(true);
      session.handleClose(0, 'test');
    } finally {
      vi.useRealTimers();
    }
  });

  it('catalog re-emission stops when its subscription ends', async () => {
    vi.useFakeTimers();
    try {
      const conn = recordingConnection();
      const aliases = recordAliases(conn);
      const { session, lines } = loggedSession(conn, 50);
      session.handleSubscribe(1n, 'catalog');
      await vi.advanceTimersByTimeAsync(120);
      expect(aliases.length).toBeGreaterThan(1);

      session.handleSubscribeClosed(1n);
      const atEnd = aliases.length;
      await vi.advanceTimersByTimeAsync(300);
      expect(aliases.length).toBe(atEnd);
      expect(lines).toContain('catalog: SUBSCRIBE cancelled by the relay (reqId=1)');
      session.handleClose(0, 'test');
    } finally {
      vi.useRealTimers();
    }
  });

  it('a close for a replaced request leaves the newer subscription serving', async () => {
    const conn = recordingConnection();
    const { session, lines } = loggedSession(conn);
    session.handleSubscribe(3n, 'video');
    session.handleSubscribe(7n, 'video');               // the relay subscribed again
    await settle();
    expect(session.publisher.videoAliasArmed).toBe(2n);

    session.handleSubscribeClosed(3n);
    expect(lines).toContain('video: SUBSCRIBE cancelled by the relay (reqId=3)');
    expect(session.publisher.videoAliasArmed).toBe(2n);
    expect(session.publisher.endedTracks).toEqual([]);
  });
});

describe('BroadcastSession — relay Forward State changes', () => {
  const frame = (tag: number) => [new Uint8Array([tag]), { isKeyframe: true, timestampUs: tag }] as const;

  it('a media pause and resume reach the publisher; a replaced request is ignored', async () => {
    const conn = recordingConnection();
    const { session, lines } = loggedSession(conn);
    session.handleSubscribe(3n, 'video');
    await settle();

    session.handleForwardChange(3n, false);
    expect(lines).toContain('video: Forward State 0 (REQUEST_UPDATE, reqId=3)');
    session.publisher.publishVideo(...frame(1));
    await settle();
    expect(conn.sends).toHaveLength(0);

    session.handleForwardChange(3n, true);
    expect(lines).toContain('video: Forward State 1 (REQUEST_UPDATE, reqId=3)');
    session.publisher.publishVideo(...frame(2));
    await settle();
    expect(conn.sends).toHaveLength(1);

    session.handleSubscribe(7n, 'video');               // the relay subscribed again
    await settle();
    session.handleForwardChange(3n, false);             // late, on the old request
    session.publisher.publishVideo(...frame(3));
    await settle();
    expect(conn.sends).toHaveLength(2);
  });

  it('a catalog pause holds re-emission; a resume sends one at once and re-emission restarts', async () => {
    vi.useFakeTimers();
    try {
      const conn = recordingConnection();
      const aliases = recordAliases(conn);
      const { session } = loggedSession(conn, 50);
      session.handleSubscribe(1n, 'catalog');
      await vi.advanceTimersByTimeAsync(0);

      session.handleForwardChange(1n, false);
      const atPause = aliases.length;
      await vi.advanceTimersByTimeAsync(300);
      expect(aliases.length).toBe(atPause);

      session.handleForwardChange(1n, true);
      await vi.advanceTimersByTimeAsync(0);
      expect(aliases.length).toBe(atPause + 1);         // sent at once
      await vi.advanceTimersByTimeAsync(160);
      expect(aliases.length).toBeGreaterThan(atPause + 1);
      expect(aliases.every((a) => a === 1n)).toBe(true);
      session.handleClose(0, 'test');
    } finally {
      vi.useRealTimers();
    }
  });

  it('with re-emission off, a resume still sends the catalog once', async () => {
    const conn = recordingConnection();
    const aliases = recordAliases(conn);
    const { session } = loggedSession(conn, 0);
    session.handleSubscribe(1n, 'catalog');
    await settle();
    session.handleForwardChange(1n, false);
    session.handleForwardChange(1n, true);
    await settle();
    expect(aliases).toEqual([1n, 1n]);
  });

  it('reports the publisher\'s largest location for media and none for the catalog', async () => {
    const conn = recordingConnection();
    const { session } = loggedSession(conn);
    session.handleSubscribe(1n, 'catalog');
    session.handleSubscribe(3n, 'video');
    await settle();
    expect(session.largestLocation(3n)).toBeNull();

    session.publisher.publishVideo(...frame(1));
    await settle();
    expect(session.largestLocation(3n)).not.toBeNull();
    expect(session.largestLocation(3n)).toEqual(session.publisher.largestLocation('video'));
    expect(session.largestLocation(1n)).toBeNull();
  });
});

describe('BroadcastSession — per-track MoQT status', () => {
  it('follows a subscription from none to forwarding, paused, and ended', async () => {
    const conn = recordingConnection();
    const { session } = loggedSession(conn);
    expect(session.trackStatus('video')).toEqual({ state: 'none' });

    session.handleSubscribe(3n, 'video');
    await settle();
    expect(session.trackStatus('video')).toEqual(
      { state: 'live', requestId: 3n, alias: 1n, forward: true, fault: false });

    session.handleForwardChange(3n, false);
    expect(session.trackStatus('video')).toMatchObject({ state: 'live', forward: false });

    session.handleSubscribeClosed(3n);
    expect(session.trackStatus('video')).toEqual(
      { state: 'none', ended: 'relay cancelled SUBSCRIBE reqId=3' });
  });

  it('reports a fault when the track is retired under a live subscription', async () => {
    const conn = recordingConnection();
    const { session } = loggedSession(conn);
    session.handleSubscribe(3n, 'video');
    await settle();
    session.publisher.endTrack('video');                 // production stopped, relay still subscribed
    expect(session.trackStatus('video')).toMatchObject({ state: 'live', fault: true });
  });

  it('a closed session serves nothing', async () => {
    const conn = recordingConnection();
    const { session } = loggedSession(conn);
    session.handleSubscribe(1n, 'catalog');
    await settle();
    expect(session.trackStatus('catalog')).toMatchObject({ state: 'live', fault: false });
    session.handleClose(0, 'test');
    expect(session.trackStatus('catalog')).toEqual({ state: 'none', ended: 'session closed' });
  });
});

/** A session on the given draft with the default catalog interval. */
function fetchSession(conn: BroadcastSessionConnection, draft: 16 | 18 = 18) {
  const lines: string[] = [];
  const session = new BroadcastSession(conn, {
    catalog: CATALOG,
    publisher: { wrapInt, draft },
    log: (m) => lines.push(m),
  });
  return { session, lines };
}

function standaloneFetch(
  trackName: string, start: [bigint, bigint], end: [bigint, bigint], descending = false,
): Fetch {
  return {
    type: 'FETCH',
    requestId: 0n,
    fetch: {
      fetchType: 0x1,
      trackNamespace: [],
      trackName: new TextEncoder().encode(trackName),
      startLocation: { group: start[0], object: start[1] },
      endLocation: { group: end[0], object: end[1] },
    },
    parameters: new Map(descending ? [[0x22n, [2n]]] : []),
  } as never;
}

function joiningFetch(joiningRequestId: bigint): Fetch {
  return {
    type: 'FETCH',
    requestId: 0n,
    fetch: { fetchType: 0x2, joiningRequestId, joiningStart: 0n },
    parameters: new Map(),
  } as never;
}

describe('BroadcastSession — FETCH (§5.2, MSF-01 §5)', () => {
  async function published() {
    const conn = recordingConnection();
    const { session, lines } = fetchSession(conn);
    session.handleSubscribe(1n, 'catalog');
    await settle();
    return { conn, session, lines, g: conn.largests[0]!.group };
  }

  it('a draft-18 catalog SUBSCRIBE_OK carries the current catalog as LARGEST_OBJECT and sends nothing', async () => {
    const { conn, session, g } = await published();
    expect(conn.largests).toEqual([{ group: g, object: 0n }]);
    expect(conn.calls).not.toContain('openSubgroup');
    expect(session.largestLocation(1n)).toEqual({ group: g, object: 0n });
  });

  it('serves the current catalog group to a FETCH that covers it', async () => {
    const { conn, session, g } = await published();
    session.handleFetch(9n, standaloneFetch('catalog', [g, 0n], [g, 1n]));
    await settle();
    expect(conn.fetchOk).toEqual([{ group: g, object: 1n }]);
    expect(conn.fetchObjects).toEqual([{ groupId: g, objectId: 0n, payload: buildCatalogPayload(CATALOG) }]);
    expect(conn.calls.slice(-4)).toEqual(['acceptFetch', 'openFetchStream', 'sendFetchObject', 'closeFetchStream']);
  });

  it('serves a Joining FETCH from the Joining Location its SUBSCRIBE_OK set', async () => {
    const { conn, session, g } = await published();
    session.handleFetch(1n, joiningFetch(1n));
    await settle();
    expect(conn.fetchOk).toEqual([{ group: g, object: 1n }]);
    expect(conn.fetchObjects.map((o) => o.groupId)).toEqual([g]);
  });

  it('serves the catalog before any SUBSCRIBE, marking earlier groups unknown', async () => {
    const conn = recordingConnection();
    const { session } = fetchSession(conn);
    session.handleFetch(9n, standaloneFetch('catalog', [0n, 0n], [1n << 62n, 0n]));
    await settle();
    const g = conn.fetchObjects[0]!.groupId;
    expect(conn.calls.slice(-3, -1)).toEqual([`endOfRange unknown ${g - 1n}/0`, 'sendFetchObject']);
  });

  it('trims a range past the current catalog to its last object', async () => {
    const { conn, session, g } = await published();
    session.handleFetch(9n, standaloneFetch('catalog', [g, 0n], [g + 5n, 0n]));
    await settle();
    expect(conn.fetchOk).toEqual([{ group: g, object: 1n }]);
  });

  it('marks earlier groups unknown: before the object ascending, after it descending', async () => {
    const { conn, session, g } = await published();
    session.handleFetch(9n, standaloneFetch('catalog', [g - 10n, 0n], [g, 1n]));
    await settle();
    expect(conn.calls.slice(-3, -1)).toEqual([`endOfRange unknown ${g - 1n}/0`, 'sendFetchObject']);

    session.handleFetch(10n, standaloneFetch('catalog', [g - 10n, 0n], [g, 1n], true));
    await settle();
    expect(conn.calls.slice(-3, -1)).toEqual(['sendFetchObject', `endOfRange unknown ${g - 10n}/0`]);
  });

  it('answers every other FETCH with one REQUEST_ERROR', async () => {
    const { conn, session, g } = await published();
    session.handleSubscribe(3n, 'video');
    await settle();
    session.handleFetch(10n, standaloneFetch('catalog', [g, 1n], [g, 2n]));          // past the current
    session.handleFetch(11n, standaloneFetch('catalog', [g - 5n, 0n], [g - 1n, 0n])); // superseded
    session.handleFetch(12n, standaloneFetch('video', [0n, 0n], [1n, 0n]));
    session.handleFetch(13n, standaloneFetch('nope', [0n, 0n], [1n, 0n]));
    session.handleFetch(14n, joiningFetch(3n));                                       // a media join
    session.handleFetch(15n, joiningFetch(99n));                                      // no Joining Location
    await settle();
    expect(conn.fetchErrors.map((e) => e.code)).toEqual([0x11n, 0x11n, 0x3n, 0x10n, 0x3n, 0x11n]);
    expect(conn.fetchOk).toEqual([]);
  });

  it('draft-16 answers FETCH with NOT_SUPPORTED', async () => {
    const conn = recordingConnection();
    const { session } = fetchSession(conn, 16);
    session.handleSubscribe(1n, 'catalog');
    await settle();
    session.handleFetch(9n, standaloneFetch('catalog', [0n, 0n], [conn.groups[0]! + 1n, 0n]));
    await settle();
    expect(conn.fetchErrors.map((e) => e.code)).toEqual([0x3n]);
  });

  it('re-emits nothing by default, and a resume sends nothing', async () => {
    vi.useFakeTimers();
    try {
      const conn = recordingConnection();
      const { session } = fetchSession(conn);
      session.handleSubscribe(1n, 'catalog');
      await vi.advanceTimersByTimeAsync(10_000);
      session.handleForwardChange(1n, false);
      session.handleForwardChange(1n, true);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(conn.calls).not.toContain('openSubgroup');
      session.handleClose(0, 'test');
    } finally {
      vi.useRealTimers();
    }
  });

  it('media SUBSCRIBE_OK carries LARGEST_OBJECT once the track has sent objects', async () => {
    const conn = recordingConnection();
    const { session } = fetchSession(conn);
    session.handleSubscribe(3n, 'video');
    await settle();
    vi.spyOn(session.publisher, 'largestLocation').mockReturnValue({ group: 7n, object: 3n });
    session.handleSubscribe(5n, 'video');
    session.handleSubscribe(6n, 'audio');
    await settle();
    expect(conn.largests).toEqual([undefined, { group: 7n, object: 3n }, { group: 7n, object: 3n }]);
  });

  it('draft-16 catalog group IDs stay strictly increasing within one millisecond', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(5_000);
    try {
      const conn = recordingConnection();
      const { session } = fetchSession(conn, 16);
      session.handleSubscribe(1n, 'catalog');
      await settle();
      session.handleForwardChange(1n, false);
      session.handleForwardChange(1n, true);
      await settle();
      expect(conn.groups).toEqual([5_000n, 5_001n]);
    } finally {
      now.mockRestore();
    }
  });
});

describe('BroadcastSession — catalog group across sessions of one broadcast', () => {
  function d18Session(conn: BroadcastSessionConnection, opts: {
    catalog?: BroadcastCatalogParams;
    carriedCatalog?: CarriedCatalog;
    onCatalogGroup?: (c: CarriedCatalog) => void;
  } = {}) {
    return new BroadcastSession(conn, {
      catalog: opts.catalog ?? CATALOG,
      publisher: { wrapInt, draft: 18 },
      log: () => {},
      ...(opts.carriedCatalog ? { carriedCatalog: opts.carriedCatalog } : {}),
      ...(opts.onCatalogGroup ? { onCatalogGroup: opts.onCatalogGroup } : {}),
    });
  }

  it('an unchanged catalog keeps the group the previous session published', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(5_000);
    try {
      let carried: CarriedCatalog | null = null;
      const first = recordingConnection();
      d18Session(first, { onCatalogGroup: (c) => { carried = c; } }).handleSubscribe(1n, 'catalog');
      await settle();
      expect(carried).toEqual({ group: 5_000n, payload: buildCatalogPayload(CATALOG) });

      now.mockReturnValue(9_000);
      const second = recordingConnection();
      const session = d18Session(second, { carriedCatalog: carried! });
      session.handleSubscribe(1n, 'catalog');
      await settle();
      expect(second.largests).toEqual([{ group: 5_000n, object: 0n }]);
      session.handleFetch(1n, joiningFetch(1n));
      await settle();
      expect(second.fetchObjects.map((o) => o.groupId)).toEqual([5_000n]);
    } finally {
      now.mockRestore();
    }
  });

  it('a changed catalog takes a new group above the carried one', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(5_000);
    try {
      const carried = { group: 5_000n, payload: buildCatalogPayload(CATALOG) };
      const conn = recordingConnection();
      d18Session(conn, { catalog: { ...CATALOG, width: 640, height: 360 }, carriedCatalog: carried })
        .handleSubscribe(1n, 'catalog');
      await settle();
      expect(conn.largests).toEqual([{ group: 5_001n, object: 0n }]);
    } finally {
      now.mockRestore();
    }
  });
});

describe('BroadcastSession — ending its subscriptions (§10.11)', () => {
  it('ends every accepted subscription with PUBLISH_DONE TRACK_ENDED and stops production', async () => {
    const conn = recordingConnection();
    const { session, lines } = fetchSession(conn);
    session.handleSubscribe(1n, 'catalog');
    session.handleSubscribe(3n, 'video');
    session.handleSubscribe(5n, 'audio');
    await settle();
    expect(session.publisher.videoAliasArmed).not.toBeNull();

    await session.endSubscriptions();
    expect(conn.dones.sort((a, b) => Number(a[0] - b[0]))).toEqual([[1n, 2n], [3n, 2n], [5n, 2n]]);
    expect(session.publisher.videoAliasArmed).toBeNull();
    expect(session.publisher.audioAliasArmed).toBeNull();
    expect(session.trackStatus('video')).toEqual({ state: 'none', ended: 'PUBLISH_DONE TRACK_ENDED reqId=3' });
    expect(lines).toContain('PUBLISH_DONE TRACK_ENDED on 3 subscription(s)');

    // Nothing left to end.
    await session.endSubscriptions();
    expect(conn.dones).toHaveLength(3);
  });

  it('a PUBLISH_DONE that never settles cannot stall the caller', async () => {
    vi.useFakeTimers();
    try {
      const conn = recordingConnection();
      conn.publishDone = () => new Promise<void>(() => { /* never settles */ });
      const { session } = fetchSession(conn);
      session.handleSubscribe(3n, 'video');
      await vi.advanceTimersByTimeAsync(0);
      let done = false;
      void session.endSubscriptions(200).then(() => { done = true; });
      await vi.advanceTimersByTimeAsync(199);
      expect(done).toBe(false);
      await vi.advanceTimersByTimeAsync(2);
      expect(done).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
