import { describe, it, expect } from 'vitest';
import type { AnchorReport, DriftReport } from './media-publisher.js';
import { MediaPublisher, CMAF_VIDEO_TRACK_ID, CMAF_AUDIO_TRACK_ID } from './media-publisher.js';
import type { MediaPublishConnection, MediaPublisherOptions } from './media-publisher.js';
import { parseLocHeaders, locWireProfileForDraft } from '@openmoq/loc';
import { MoqtConnectionError } from '@openmoq/webtransport';
import { readBaseMediaDecodeTime, readSegmentTimeRanges } from '../../packages/browser/src/mp4-box.js';
import { buildAudioInit, buildVideoInit, MICROSECOND_TIMESCALE } from '../shared/browser/cmaf-mux.js';
import {
  codecDescriptionFromInit, deserializeLocmafObject, LocmafGroupState, LocmafReconstructor, parseCmafChunk,
  parseLocmafTrackContext,
} from '@openmoq/locmaf';

const wrapInt = (n: bigint) => n;

interface SendRecord { streamId: bigint; objectId: bigint; payload: Uint8Array; extensions?: Uint8Array }

/**
 * Records every publication call. `holdSends` makes sendObject return
 * promises that resolve only when the test releases them — the WebCodecs
 * backpressure scenario where chunk callbacks outpace the network.
 */
function recordingConnection(opts: { holdSends?: boolean; holdCloses?: boolean } = {}) {
  const opened: Array<{ alias: bigint; groupId: bigint; streamId: bigint; options: Record<string, unknown> }> = [];
  const sends: SendRecord[] = [];
  const closed: bigint[] = [];
  const pending: Array<{ resolve: () => void; reject: (e: Error) => void }> = [];
  const pendingCloses: Array<() => void> = [];
  let nextStream = 100n;
  const conn: MediaPublishConnection & {
    opened: typeof opened; sends: typeof sends; closed: typeof closed;
    pendingCount: () => number;
    rejectAllPending: (e: Error) => Promise<void>;
    releaseCloses: () => Promise<void>;
    releaseLastClose: () => Promise<void>;
    releaseAll: () => Promise<void>;
  } = {
    opened, sends, closed,
    openSubgroup: async (alias, groupId, _subgroupId, options) => {
      const streamId = nextStream++;
      opened.push({ alias: alias as bigint, groupId: groupId as bigint, streamId, options });
      return streamId;
    },
    sendObject: (streamId, objectId, payload, extensions) => {
      sends.push({ streamId, objectId: objectId as bigint, payload, ...(extensions ? { extensions } : {}) });
      if (!opts.holdSends) return Promise.resolve();
      return new Promise<void>((resolve, reject) => { pending.push({ resolve, reject }); });
    },
    closeSubgroup: (streamId) => {
      closed.push(streamId);
      if (!opts.holdCloses) return Promise.resolve();
      return new Promise<void>((resolve) => { pendingCloses.push(resolve); });
    },
    pendingCount: () => pending.length,
    rejectAllPending: async (e) => {
      while (pending.length > 0) pending.shift()!.reject(e);
      await new Promise((r) => setTimeout(r, 0));
    },
    releaseCloses: async () => {
      while (pendingCloses.length > 0) pendingCloses.shift()!();
      await new Promise((r) => setTimeout(r, 0));
    },
    releaseLastClose: async () => {
      pendingCloses.pop()?.();
      await new Promise((r) => setTimeout(r, 0));
    },
    releaseAll: async () => {
      // Chained sends only become pending after the previous one resolves —
      // keep releasing until a full macrotask passes with nothing pending.
      for (let quiet = 0; quiet < 2;) {
        while (pending.length > 0) pending.shift()!.resolve();
        while (pendingCloses.length > 0) pendingCloses.shift()!();
        await new Promise((r) => setTimeout(r, 0));
        quiet = pending.length === 0 && pendingCloses.length === 0 ? quiet + 1 : 0;
      }
    },
  };
  return conn;
}

const chunk = (tag: number) => new Uint8Array([tag]);
const kf = (timestampUs = 1_000) => ({ isKeyframe: true, timestampUs });
const delta = (timestampUs = 2_000) => ({ isKeyframe: false, timestampUs });
const makePublisher = (conn: MediaPublishConnection, opts: Partial<MediaPublisherOptions> = {}) =>
  new MediaPublisher(conn, { wrapInt, draft: 16, ...opts });

async function settle() { await new Promise((r) => setTimeout(r, 0)); }

describe('MediaPublisher — serialized video publication', () => {
  it('back-to-back chunks with deferred sends get UNIQUE, ORDERED object IDs on one subgroup', async () => {
    const conn = recordingConnection({ holdSends: true });
    const pub = makePublisher(conn);
    pub.setVideoAlias(2n);

    // WebCodecs delivers three chunks synchronously while the first send is
    // still in flight — the exact interleaving that made unserialized
    // handlers reuse an object ID.
    pub.publishVideo(chunk(0), kf());
    pub.publishVideo(chunk(1), delta());
    pub.publishVideo(chunk(2), delta());

    await conn.releaseAll();

    expect(conn.opened).toHaveLength(1); // one keyframe → one subgroup
    expect(conn.sends.map((s) => s.objectId)).toEqual([0n, 1n, 2n]);
    expect(conn.sends.map((s) => s.payload[0])).toEqual([0, 1, 2]); // enqueue order preserved
    expect(new Set(conn.sends.map((s) => s.streamId)).size).toBe(1);
  });

  it('a keyframe queued behind in-flight deltas rotates the group AFTER they complete — no premature close', async () => {
    const conn = recordingConnection({ holdSends: true });
    const pub = makePublisher(conn);
    pub.setVideoAlias(2n);

    pub.publishVideo(chunk(0), kf());   // group A, object 0
    pub.publishVideo(chunk(1), delta());  // group A, object 1
    pub.publishVideo(chunk(2), kf());   // rotates to group B
    await conn.releaseAll();

    expect(conn.opened).toHaveLength(2);
    const [groupA, groupB] = conn.opened;
    expect(groupB!.groupId).toBe(groupA!.groupId + 1n);
    // Group A's stream closed only at rotation — after BOTH its sends landed.
    expect(conn.closed).toEqual([groupA!.streamId]);
    const bySend = conn.sends.map((s) => [s.streamId, s.objectId]);
    expect(bySend).toEqual([
      [groupA!.streamId, 0n],
      [groupA!.streamId, 1n],
      [groupB!.streamId, 0n], // object ID reset for the new group
    ]);
  });

  it('chunks before the first keyframe are skipped without opening a stream', async () => {
    const conn = recordingConnection();
    const pub = makePublisher(conn);
    pub.setVideoAlias(2n);
    pub.publishVideo(chunk(0), delta());
    await settle();
    expect(conn.opened).toHaveLength(0);
    expect(conn.sends).toHaveLength(0);
  });

  it('a FAILED keyframe send retires the subgroup: deltas are dropped until the next keyframe opens a fresh group at Object 0', async () => {
    // LOC: Object 0 of a subgroup must be the independent frame. Publishing a
    // dependent frame as Object 0 after a failed keyframe send would produce
    // a malformed group — the subgroup must be retired instead.
    const conn = recordingConnection();
    let failNext = true;
    const realSend = conn.sendObject.bind(conn);
    conn.sendObject = (sid, oid, payload) => {
      const p = realSend(sid, oid, payload);
      if (failNext) { failNext = false; return Promise.reject(new Error('write blew up')); }
      return p;
    };
    const errors: string[] = [];
    const pub = makePublisher(conn, { onError: (ctx, err) => errors.push(`${ctx}: ${(err as Error).message}`) });
    pub.setVideoAlias(2n);

    pub.publishVideo(chunk(0), kf());   // keyframe — send FAILS
    pub.publishVideo(chunk(1), delta());  // dependent frame — must be DROPPED
    pub.publishVideo(chunk(2), kf());   // next keyframe — fresh group recovers
    pub.publishVideo(chunk(3), delta());  // dependent frame in the NEW group
    await settle();

    expect(errors).toEqual(['video publish: write blew up']);
    const brokenStream = conn.opened[0]!.streamId;
    // The broken subgroup was retired (closed) and never carried another send.
    expect(conn.closed).toContain(brokenStream);
    const successful = conn.sends.slice(1); // index 0 is the failed attempt
    expect(successful.every((x) => x.streamId !== brokenStream)).toBe(true);
    // The delta between the failure and the next keyframe never went out.
    expect(successful.map((x) => x.payload[0])).toEqual([2, 3]);
    // The fresh group starts at Object 0 with the INDEPENDENT frame.
    expect(successful.map((x) => x.objectId)).toEqual([0n, 1n]);
    expect(conn.opened).toHaveLength(2);
    expect(conn.opened[1]!.groupId).toBe(conn.opened[0]!.groupId + 1n);
  });

  it('a failed ROTATION open cannot revive the previous stream: deltas drop until a keyframe opens successfully', async () => {
    const conn = recordingConnection();
    let failOpen = false;
    const realOpen = conn.openSubgroup.bind(conn);
    conn.openSubgroup = (alias, groupId, subgroupId, options) => {
      if (failOpen) { failOpen = false; return Promise.reject(new Error('open refused')); }
      return realOpen(alias, groupId, subgroupId, options);
    };
    const errors: string[] = [];
    const pub = makePublisher(conn, { onError: (ctx, err) => errors.push(`${ctx}: ${(err as Error).message}`) });
    pub.setVideoAlias(2n);

    pub.publishVideo(chunk(0), kf());   // group A opens, object 0
    await settle();                     // group A is established before the flag flips
    failOpen = true;
    pub.publishVideo(chunk(1), kf());   // rotation: A closed, NEW open FAILS
    pub.publishVideo(chunk(2), delta());  // must be dropped — NOT sent on A
    pub.publishVideo(chunk(3), kf());   // next keyframe recovers on group C
    await settle();

    expect(errors).toEqual(['video publish: open refused']);
    const streamA = conn.opened[0]!.streamId;
    expect(conn.closed).toContain(streamA);
    // Nothing was ever sent on A after its rotation close — the slot was
    // cleared BEFORE the open, so the failure could not revive it.
    const afterRotation = conn.sends.slice(1);
    expect(afterRotation.every((x) => x.streamId !== streamA)).toBe(true);
    expect(afterRotation.map((x) => [x.payload[0], x.objectId])).toEqual([[3, 0n]]);
  });

  it('a throwing onError sink is contained: later chunks publish and stop() resolves', async () => {
    const conn = recordingConnection();
    let failNext = true;
    const realSend = conn.sendObject.bind(conn);
    conn.sendObject = (sid, oid, payload) => {
      if (failNext) { failNext = false; return Promise.reject(new Error('write blew up')); }
      return realSend(sid, oid, payload);
    };
    const pub = makePublisher(conn, {
      onError: () => { throw new Error('error sink itself blew up'); },
    });
    pub.setVideoAlias(2n);
    pub.publishVideo(chunk(0), kf());   // fails → onError throws → must not poison the chain
    pub.publishVideo(chunk(1), kf());   // fresh keyframe must still publish
    await settle();
    expect(conn.sends.filter((x) => x.payload[0] === 1)).toHaveLength(1);
    await expect(pub.stop()).resolves.toBeUndefined();
  });
});

describe('MediaPublisher — Forward State 0 pause', () => {
  /** A connection whose sends fail with the adapter's §5.1 message until
   *  `forwarding` is flipped on. */
  function forwardGated(conn: ReturnType<typeof recordingConnection>) {
    const realSend = conn.sendObject.bind(conn);
    const gate = { forwarding: false };
    conn.sendObject = (sid, oid, payload, ext) => (gate.forwarding
      ? realSend(sid, oid, payload, ext)
      : Promise.reject(new Error(
        `sendObject: stream ${String(sid)} belongs to a subscription with `
        + 'Forward State 0 — no Objects may be sent (§5.1)')));
    return gate;
  }

  it('pauses instead of retiring, keeps the alias, and reports once', async () => {
    const conn = recordingConnection();
    forwardGated(conn);
    const errors: string[] = [];
    const statuses: string[] = [];
    const pub = makePublisher(conn, {
      onError: (ctx, err) => errors.push(`${ctx}: ${(err as Error).message}`),
      onStatus: (track, message) => statuses.push(`${track}: ${message}`),
    });
    pub.setVideoAlias(2n);

    pub.publishVideo(chunk(0), kf());
    await settle();
    pub.publishVideo(chunk(1), kf());   // suppressed while paused
    pub.publishVideo(chunk(2), kf());
    await settle();

    expect(pub.pausedTracks).toEqual(['video']);
    // Retiring would clear the alias, and no new SUBSCRIBE follows a
    // Forward 0→1 resume — the track would never come back.
    expect(pub.endedTracks).toEqual([]);
    expect(statuses).toEqual(['video: Forward State 0 (a send was refused)']);
    expect(errors).toEqual([]);
  });

  it('resumes production when forwarding returns, with no new SUBSCRIBE', async () => {
    const conn = recordingConnection();
    const gate = forwardGated(conn);
    const statuses: string[] = [];
    const pub = makePublisher(conn, {
      pauseProbeMs: 1,
      onStatus: (track, message) => statuses.push(`${track}: ${message}`),
    });
    pub.setVideoAlias(2n);

    pub.publishVideo(chunk(0), kf());
    await settle();
    expect(pub.pausedTracks).toEqual(['video']);

    gate.forwarding = true;
    await new Promise((r) => setTimeout(r, 5));   // probe window elapses
    pub.publishVideo(chunk(1), kf());
    await settle();

    expect(pub.pausedTracks).toEqual([]);
    expect(conn.sends.map((s) => s.payload[0])).toEqual([1]);
    expect(statuses).toContain('video: Forward State 1 (a send went through)');
  });
});

describe('MediaPublisher — audio publication', () => {
  it('a failed audio send still closes its stream (best-effort terminal cleanup) and the next chunk recovers', async () => {
    const conn = recordingConnection();
    let failNext = true;
    const realSend = conn.sendObject.bind(conn);
    conn.sendObject = (sid, oid, payload) => {
      if (failNext) { failNext = false; return Promise.reject(new Error('audio write blew up')); }
      return realSend(sid, oid, payload);
    };
    const errors: string[] = [];
    const pub = makePublisher(conn, { onError: (ctx, err) => errors.push(`${ctx}: ${(err as Error).message}`) });
    pub.setAudioAlias(3n);
    pub.publishAudio(chunk(0), { timestampUs: 500 });
    pub.publishAudio(chunk(1), { timestampUs: 500 });
    await settle();
    expect(errors).toEqual(['audio publish: audio write blew up']);
    // BOTH streams were closed — the failed one via best-effort cleanup.
    expect(conn.closed.sort()).toEqual([conn.opened[0]!.streamId, conn.opened[1]!.streamId].sort());
    expect(conn.sends.filter((x) => x.payload[0] === 1)).toHaveLength(1);
  });

  it('publishes one object per group on sequential group IDs', async () => {
    const conn = recordingConnection();
    const pub = makePublisher(conn);
    pub.setAudioAlias(3n);
    pub.publishAudio(chunk(0), { timestampUs: 500 });
    pub.publishAudio(chunk(1), { timestampUs: 500 });
    await settle();
    expect(conn.opened).toHaveLength(2);
    expect(conn.opened[1]!.groupId).toBe(conn.opened[0]!.groupId + 1n);
    expect(conn.sends.map((s) => s.objectId)).toEqual([0n, 0n]);
    expect(conn.closed).toEqual([conn.opened[0]!.streamId, conn.opened[1]!.streamId]);
  });
});

describe('MediaPublisher — CMAF packaging', () => {
  const wall = 1_759_000_000_000_000;
  const profile = { wireProfile: locWireProfileForDraft(16) };

  it('wraps a video frame in a CMAF chunk whose decode time is the capture timestamp', async () => {
    const conn = recordingConnection();
    const pub = makePublisher(conn, { packaging: 'cmaf', wallClockUs: () => wall });
    pub.setVideoAlias(2n);
    pub.publishVideo(chunk(7), { isKeyframe: true, timestampUs: 1_000, durationUs: 41_708 });
    await settle();

    const sent = conn.sends[0]!;
    const headers = parseLocHeaders(sent.extensions!, profile);
    expect(headers.videoFrameMarking).toBeUndefined(); // CMAF carries its own sync flags
    expect(readBaseMediaDecodeTime(sent.payload)).toBe(headers.captureTimestamp);
    expect(readSegmentTimeRanges(sent.payload)).toEqual([{
      startTime: headers.captureTimestamp!, endTime: headers.captureTimestamp! + 41_708n, sampleCount: 1,
    }]);
    expect(sent.payload[sent.payload.length - 1]).toBe(7);
  });

  it('gives a video frame the median recent capture interval, not the last one', async () => {
    const conn = recordingConnection();
    const pub = makePublisher(conn, { packaging: 'cmaf', wallClockUs: () => wall });
    pub.setVideoAlias(2n);
    // 24 fps, then a frame 4 ms after the last (burst), then one after a skipped frame.
    const stamps = [0, 41_700, 83_400, 125_100, 129_100, 208_500];
    stamps.forEach((timestampUs, i) => pub.publishVideo(chunk(i), { isKeyframe: i === 0, timestampUs }));
    await settle();

    const durations = conn.sends.map((s) => {
      const [r] = readSegmentTimeRanges(s.payload)!;
      return Number(r!.endTime - r!.startTime);
    });
    expect(durations).toEqual([33_333, 41_700, 41_700, 41_700, 41_700, 41_700]);
  });

  it('wraps an audio chunk the same way, one per group', async () => {
    const conn = recordingConnection();
    const pub = makePublisher(conn, { packaging: 'cmaf', wallClockUs: () => wall });
    pub.setAudioAlias(3n);
    pub.publishAudio(chunk(9), { timestampUs: 500, durationUs: 20_000 });
    await settle();

    const sent = conn.sends[0]!;
    const capture = parseLocHeaders(sent.extensions!, profile).captureTimestamp!;
    expect(readSegmentTimeRanges(sent.payload)).toEqual([
      { startTime: capture, endTime: capture + 20_000n, sampleCount: 1 },
    ]);
    expect(sent.payload[sent.payload.length - 1]).toBe(9);
  });

  /** Decode-time steps between the sent video chunks. */
  const decodeSteps = (sends: SendRecord[]) => {
    const d = sends.map((s) => readBaseMediaDecodeTime(s.payload)!);
    return d.slice(1).map((t, i) => Number(t - d[i]!));
  };
  const publishFrames = async (stamps: number[]) => {
    const conn = recordingConnection();
    const pub = makePublisher(conn, { packaging: 'cmaf', wallClockUs: () => wall });
    pub.setVideoAlias(2n);
    stamps.forEach((timestampUs, i) =>
      pub.publishVideo(chunk(i), { isKeyframe: i === 0, timestampUs, durationUs: 41_700 }));
    await settle();
    return conn;
  };

  it('keeps one skipped frame under MSE\'s discontinuity threshold (twice the last duration)', async () => {
    const conn = await publishFrames([0, 41_700, 83_400, 167_400, 209_100]);
    expect(decodeSteps(conn.sends)).toEqual([41_700, 41_700, 83_300, 42_400]);
  });

  it('catches up after a capture stall over the following frames, never past the threshold', async () => {
    const stamps = [0, 41_700, 83_400, ...Array.from({ length: 15 }, (_, i) => 541_400 + i * 41_700)];
    const conn = await publishFrames(stamps);
    const steps = decodeSteps(conn.sends);
    expect(Math.max(...steps)).toBeLessThanOrEqual(83_300);
    const first = readBaseMediaDecodeTime(conn.sends[0]!.payload)!;
    const last = readBaseMediaDecodeTime(conn.sends.at(-1)!.payload)!;
    expect(Number(last - first)).toBe(stamps.at(-1));
  });

  it('keeps a pause (over 1 s) as a real gap', async () => {
    const conn = await publishFrames([0, 41_700, 1_541_700]);
    expect(decodeSteps(conn.sends)).toEqual([41_700, 1_500_000]);
  });

  it('leaves LOC payloads as the encoded frame', async () => {
    const conn = recordingConnection();
    const pub = makePublisher(conn);
    pub.setAudioAlias(3n);
    pub.publishAudio(chunk(9), { timestampUs: 500 });
    await settle();
    expect(conn.sends[0]!.payload).toEqual(chunk(9));
  });
});

describe('MediaPublisher — LOCMAF packaging', () => {
  const wall = 1_759_000_000_000_000;
  const videoInit = buildVideoInit({
    trackId: CMAF_VIDEO_TRACK_ID, timescale: MICROSECOND_TIMESCALE, codec: 'avc1.42c01e',
    width: 640, height: 360, description: new Uint8Array([0x01, 0x42, 0xc0, 0x1e, 0xff, 0xe0, 0x00]),
  });
  const audioInit = buildAudioInit({
    trackId: CMAF_AUDIO_TRACK_ID, timescale: MICROSECOND_TIMESCALE, sampleRate: 48_000, channels: 1,
  });
  const cmafInit = () => ({ videoInit, audioInit });
  const frame = (isKeyframe: boolean, timestampUs: number) => ({ isKeyframe, timestampUs, durationUs: 40_000 });

  /** The same video frames through a CMAF and a LOCMAF publisher. */
  async function publishBoth(frames: ReturnType<typeof frame>[]) {
    const run = async (packaging: 'cmaf' | 'locmaf') => {
      const conn = recordingConnection();
      const pub = makePublisher(conn, { packaging, cmafInit, wallClockUs: () => wall });
      pub.setVideoAlias(2n);
      frames.forEach((f, i) => pub.publishVideo(chunk(i), f));
      await settle();
      return { conn, pub };
    };
    return { cmaf: await run('cmaf'), locmaf: await run('locmaf') };
  }

  /** Rebuild each LOCMAF object of one track, group by group. */
  function reconstructAll(sends: SendRecord[], init: Uint8Array): Uint8Array[] {
    const context = parseLocmafTrackContext(init);
    const reconstructor = new LocmafReconstructor();
    let state = new LocmafGroupState();
    return sends.map((sent) => {
      if (sent.objectId === 0n) state = new LocmafGroupState();
      const rebuilt = reconstructor.reconstruct(deserializeLocmafObject(sent.payload), state, context, sent.objectId);
      expect(rebuilt.kind).toBe('chunk');
      return rebuilt.bytes;
    });
  }

  /** Decode time, per-sample values and media bytes; the rebuild is canonical, not our byte layout. */
  const samplesOf = (chunkBytes: Uint8Array, init: Uint8Array) => {
    const parsed = parseCmafChunk(chunkBytes, parseLocmafTrackContext(init));
    if (!parsed.fits) throw new Error(parsed.reason);
    return { effective: parsed.effective, mdat: [...parsed.mdat] };
  };

  it('each video object rebuilds into the samples of its CMAF chunk, smaller on the wire', async () => {
    const { cmaf, locmaf } = await publishBoth([
      frame(true, 0), frame(false, 40_000), frame(false, 80_000), frame(true, 120_000),
    ]);
    expect(reconstructAll(locmaf.conn.sends, videoInit).map((c) => samplesOf(c, videoInit)))
      .toEqual(cmaf.conn.sends.map((s) => samplesOf(s.payload, videoInit)));
    locmaf.conn.sends.forEach((s, i) => {
      expect(s.payload.byteLength).toBeLessThan(cmaf.conn.sends[i]!.payload.byteLength);
    });
  });

  it('starts each group with a full header and chains deltas inside it', async () => {
    const { locmaf } = await publishBoth([
      frame(true, 0), frame(false, 40_000), frame(false, 80_000), frame(true, 120_000), frame(false, 160_000),
    ]);
    expect(locmaf.pub.locmafHeaders).toEqual({ full: 2, delta: 3 });
  });

  /** Decode start of each sent object, rebuilt from its LOCMAF payload. */
  const decodeStarts = (sends: SendRecord[], init: Uint8Array) =>
    reconstructAll(sends, init).map((c) => samplesOf(c, init).effective.baseMediaDecodeTime);

  it('keeps decode times on a regular timeline through capture jitter, so headers stay deltas', async () => {
    const { locmaf } = await publishBoth([frame(true, 0), frame(false, 40_150), frame(false, 79_900)]);
    expect(locmaf.pub.locmafHeaders).toEqual({ full: 1, delta: 2 });
    const [d0, d1, d2] = decodeStarts(locmaf.conn.sends, videoInit);
    expect([d1! - d0!, d2! - d1!]).toEqual([40_000n, 40_000n]);
  });

  it('keeps a skipped frame under MSE\'s discontinuity threshold on the LOCMAF timeline too', async () => {
    const { locmaf } = await publishBoth([frame(true, 0), frame(false, 40_000), frame(false, 120_100)]);
    const [d0, d1, d2] = decodeStarts(locmaf.conn.sends, videoInit);
    expect([d1! - d0!, d2! - d1!]).toEqual([40_000n, 79_900n]);
  });

  it('snaps back to capture time past half a frame, with a full header', async () => {
    const { locmaf } = await publishBoth([frame(true, 0), frame(false, 40_000), frame(false, 105_000)]);
    expect(locmaf.pub.locmafHeaders).toEqual({ full: 2, delta: 1 });
    const [d0, , d2] = decodeStarts(locmaf.conn.sends, videoInit);
    expect(d2! - d0!).toBe(105_000n);
  });

  it('groups audio with video: one subgroup per video group, deltas inside it', async () => {
    const conn = recordingConnection();
    const pub = makePublisher(conn, { draft: 18, packaging: 'locmaf', cmafInit, wallClockUs: () => wall });
    pub.setVideoAlias(2n);
    pub.setAudioAlias(3n);
    const audio = (from: number, n: number) => {
      for (let i = 0; i < n; i++) pub.publishAudio(chunk(i), { timestampUs: from + i * 20_000, durationUs: 20_000 });
    };
    pub.publishVideo(chunk(0), frame(true, 0));
    await settle();
    audio(0, 5);
    await settle();
    pub.publishVideo(chunk(1), frame(true, 100_000));
    await settle();
    audio(100_000, 3);
    await settle();

    const audioStreams = conn.opened.filter((o) => o.alias === 3n);
    expect(audioStreams).toHaveLength(2);
    expect(audioStreams[1]!.groupId).toBe(audioStreams[0]!.groupId + 1n);
    const audioSends = conn.sends.filter((s) => audioStreams.some((o) => o.streamId === s.streamId));
    expect(audioSends.map((s) => s.objectId)).toEqual([0n, 1n, 2n, 3n, 4n, 0n, 1n, 2n]);
    // Video: 2 full. Audio: a full header per group, deltas after it.
    expect(pub.locmafHeaders).toEqual({ full: 4, delta: 6 });
    expect(reconstructAll(audioSends, audioInit).map((c) => c[c.length - 1])).toEqual([0, 1, 2, 3, 4, 0, 1, 2]);
  });

  it('starts a new audio group after 2 s without a video group', async () => {
    const conn = recordingConnection();
    const pub = makePublisher(conn, {
      draft: 18, packaging: 'locmaf', cmafInit, wallClockUs: () => wall, audioQueueMax: 200,
    });
    pub.setAudioAlias(3n);
    for (let i = 0; i < 150; i++) pub.publishAudio(chunk(i % 250), { timestampUs: i * 20_000, durationUs: 20_000 });
    await settle();
    await pub.stop();

    const groups = conn.opened.filter((o) => o.alias === 3n);
    expect(groups).toHaveLength(2);
    expect(conn.sends.filter((s) => s.streamId === groups[0]!.streamId)).toHaveLength(100);
    expect(conn.closed).toEqual(expect.arrayContaining(groups.map((g) => g.streamId)));
  });

  it('keeps audio on subgroups even when datagrams are asked for', async () => {
    const conn = recordingConnection();
    let datagrams = 0;
    (conn as unknown as { sendDatagram: unknown }).sendDatagram = async () => { datagrams++; };
    const pub = makePublisher(conn, {
      draft: 18, audioDatagrams: true, packaging: 'locmaf', cmafInit, wallClockUs: () => wall,
    });
    pub.setAudioAlias(3n);
    pub.publishAudio(chunk(9), { timestampUs: 500, durationUs: 20_000 });
    await settle();

    expect(datagrams).toBe(0);
    expect(conn.opened).toHaveLength(1);
    const [rebuilt] = reconstructAll(conn.sends, audioInit);
    expect(rebuilt![rebuilt!.length - 1]).toBe(9);
  });

  it('the Opus init gives the frame path a WebCodecs OpusHead', () => {
    const head = codecDescriptionFromInit(audioInit)!;
    expect(new TextDecoder().decode(head.subarray(0, 8))).toBe('OpusHead');
    expect(head[9]).toBe(1);                                          // channels
    expect(new DataView(head.buffer).getUint32(12, true)).toBe(48_000); // input sample rate
  });

  it('reports a send without init segments as an error and sends nothing', async () => {
    const conn = recordingConnection();
    const errors: unknown[] = [];
    const pub = makePublisher(conn, { packaging: 'locmaf', onError: (_c, e) => errors.push(e) });
    pub.setVideoAlias(2n);
    pub.publishVideo(chunk(0), frame(true, 0));
    await settle();

    expect(conn.sends).toHaveLength(0);
    expect(String((errors[0] as Error)?.message)).toContain('no CMAF init segment');
  });
});

describe('MediaPublisher — broadcast generations', () => {
  it('stop() drains deterministically: in-flight work completes, queued work is dropped, late enqueues are ignored', async () => {
    const conn = recordingConnection({ holdSends: true });
    const pub = makePublisher(conn);
    pub.setVideoAlias(2n);

    pub.publishVideo(chunk(0), kf());   // becomes in flight (held)
    pub.publishVideo(chunk(1), delta());  // queued, not started
    await settle();                     // let the first send actually start

    let stopResolved = false;
    const stopPromise = pub.stop().then(() => { stopResolved = true; });
    await settle();
    expect(stopResolved).toBe(false);   // waits for the in-flight send

    await conn.releaseAll();
    await stopPromise;

    // The held send completed; the queued chunk was dropped at drain.
    expect(conn.sends.map((s) => s.payload[0])).toEqual([0]);
    // The open subgroup was closed by stop().
    expect(conn.closed).toEqual([conn.opened[0]!.streamId]);

    pub.publishVideo(chunk(9), kf());   // late enqueue after stop
    await settle();
    expect(conn.sends).toHaveLength(1);
  });

  it('a deferred rotation close is TRACKED: drain does not resolve until it settles', async () => {
    const conn = recordingConnection({ holdCloses: true });
    const pub = makePublisher(conn);
    pub.setVideoAlias(2n);
    pub.publishVideo(chunk(0), kf());   // group A
    pub.publishVideo(chunk(1), kf());   // rotation: close(A) HELD, group B opens
    await settle();
    expect(conn.closed).toHaveLength(1); // close(A) initiated, still pending

    pub.retire();
    let drained = false;
    const drainPromise = pub.drain().then(() => { drained = true; });
    await settle();
    expect(drained).toBe(false);

    // Drain also closes the still-open group B — settle THAT close first, so
    // the ONLY thing left outstanding is the rotation close of A. A drain
    // that fired-and-forgot the rotation close would resolve right here.
    await conn.releaseLastClose();
    await settle();
    expect(drained).toBe(false);        // the rotation close is part of the drain

    await conn.releaseCloses();         // settles close(A)
    await drainPromise;
    expect(conn.closed).toEqual(expect.arrayContaining([conn.opened[0]!.streamId, conn.opened[1]!.streamId]));
  });

  it('a never-settling send does not wedge shutdown: retirement is synchronous and connection closure unblocks the drain', async () => {
    const conn = recordingConnection({ holdSends: true });
    const errors: string[] = [];
    const pub = makePublisher(conn, { onError: (ctx, err) => errors.push(`${ctx}: ${(err as Error).message}`) });
    pub.setVideoAlias(2n);
    pub.publishVideo(chunk(0), kf());
    await settle();
    expect(conn.pendingCount()).toBe(1); // the send is stalled

    // The main.ts shutdown order: retire synchronously, close the connection
    // (which rejects in-flight writes), THEN drain — never the reverse.
    pub.retire();
    const drainPromise = pub.drain();
    await conn.rejectAllPending(new Error('connection closed'));
    await expect(drainPromise).resolves.toBeUndefined();
    expect(errors).toEqual(['video publish: connection closed']);
  });

  it('two-cycle restart: the new generation never publishes through a stale alias, the old one never touches the new session', async () => {
    // Cycle 1: broadcast on connection A with aliases bound.
    const connA = recordingConnection();
    const pubA = makePublisher(connA);
    pubA.setVideoAlias(2n);
    pubA.setAudioAlias(3n);
    pubA.publishVideo(chunk(0), kf());
    pubA.publishAudio(chunk(1), { timestampUs: 500 });
    await settle();
    expect(connA.sends).toHaveLength(2);
    await pubA.stop();

    // Cycle 2: a FRESH publisher on connection B — aliases start unset.
    const connB = recordingConnection();
    const pubB = makePublisher(connB);

    // Encoders can fire before the relay subscribes on the new session; a
    // stale-alias publication here was the reported defect.
    pubB.publishVideo(chunk(2), kf());
    pubB.publishAudio(chunk(3), { timestampUs: 500 });
    await settle();
    expect(connB.opened).toHaveLength(0);
    expect(connB.sends).toHaveLength(0);

    // Once the new session's aliases bind, publication resumes — on B only.
    pubB.setVideoAlias(7n);
    pubB.publishVideo(chunk(4), kf());
    await settle();
    expect(connB.opened).toHaveLength(1);
    expect(connB.opened[0]!.alias).toBe(7n);
    expect(connB.sends).toHaveLength(1);

    // The old generation stays inert even if something still holds it.
    pubA.publishVideo(chunk(5), kf());
    await settle();
    expect(connA.sends).toHaveLength(2); // unchanged — nothing new on the old session
  });
});

describe('MediaPublisher — negotiated-draft wire binding', () => {
  it('draft-18 subgroup opens set FIRST_OBJECT on video AND audio; 16/14 do not', async () => {
    for (const draft of [14, 16, 18] as const) {
      const conn = recordingConnection();
      const pub = makePublisher(conn, { draft });
      pub.setVideoAlias(2n);
      pub.setAudioAlias(3n);
      pub.publishVideo(chunk(0), kf());
      pub.publishAudio(chunk(1), { timestampUs: 500 });
      await settle();
      expect(conn.opened).toHaveLength(2);
      for (const o of conn.opened) {
        if (draft === 18) {
          expect(o.options['firstObject']).toBe(true); // §2.2 MUST for the original publisher
        } else {
          expect('firstObject' in o.options).toBe(false); // d14/16 bytes preserved
        }
      }
    }
  });

  it('draft-18 LOC extensions use the vi64 profile: they parse as d18 and are NOT d16 bytes', async () => {
    const timestampUs = Date.now() * 1000; // a current capture timestamp
    // Pin the wall clock to the chunk's own base so the per-track rebase is a
    // no-op here: this test is about the wire profile, not about anchoring.
    const wallClockUs = () => timestampUs;
    const conn18 = recordingConnection();
    const pub18 = makePublisher(conn18, { draft: 18, wallClockUs });
    pub18.setVideoAlias(2n);
    pub18.publishVideo(chunk(7), { isKeyframe: true, timestampUs });
    await settle();

    const ext = conn18.sends[0]!.extensions;
    expect(ext).toBeDefined();
    const parsed = parseLocHeaders(ext, { wireProfile: locWireProfileForDraft(18) });
    expect(parsed.captureTimestamp).toBe(BigInt(Math.round(timestampUs)));
    expect(parsed.videoFrameMarking?.independent).toBe(true);

    // The same publisher under draft 16 emits DIFFERENT bytes (QUIC-varint
    // profile) — proving the profile is draft-bound, not fixed.
    const conn16 = recordingConnection();
    const pub16 = makePublisher(conn16, { draft: 16, wallClockUs });
    pub16.setVideoAlias(2n);
    pub16.publishVideo(chunk(7), { isKeyframe: true, timestampUs });
    await settle();
    const ext16 = conn16.sends[0]!.extensions;
    expect(Buffer.from(ext16!).equals(Buffer.from(ext!))).toBe(false);
    const parsed16 = parseLocHeaders(ext16, { wireProfile: locWireProfileForDraft(16) });
    expect(parsed16.captureTimestamp).toBe(BigInt(Math.round(timestampUs)));
  });
});

describe('MediaPublisher — frame marking', () => {
  it('marks no frame discardable: without temporal layers every P-frame is a reference', async () => {
    const conn = recordingConnection();
    const pub = makePublisher(conn, { draft: 18 });
    pub.setVideoAlias(2n);
    pub.publishVideo(chunk(0), kf());
    pub.publishVideo(chunk(1), delta());
    await conn.releaseAll();

    const profile = { wireProfile: locWireProfileForDraft(18) };
    const marks = conn.sends.map((s) => parseLocHeaders(s.extensions!, profile).videoFrameMarking);
    expect(marks.map((m) => m?.independent)).toEqual([true, false]);
    expect(marks.map((m) => m?.discardable)).toEqual([false, false]);
  });
});

describe('MediaPublisher — bounded backpressure', () => {
  it('video: sustained chunks far beyond the cap stay bounded; recovery is a keyframe at Object 0', async () => {
    const conn = recordingConnection({ holdSends: true });
    const errors: string[] = [];
    const pub = makePublisher(conn, {
      videoQueueMax: 10,
      onError: (ctx, err) => errors.push(`${ctx}: ${(err as Error).message}`),
    });
    pub.setVideoAlias(2n);

    // One keyframe starts a group; its send is held. 500 deltas pour in.
    pub.publishVideo(chunk(0), kf());
    await settle();
    for (let i = 0; i < 500; i++) pub.publishVideo(chunk(1), delta());

    // Enqueued state is BOUNDED: nothing beyond the cap is retained.
    expect((pub as unknown as { videoQueue: unknown[] }).videoQueue.length).toBeLessThanOrEqual(10);
    expect(errors.filter((e) => /overflow/.test(e)).length).toBeGreaterThanOrEqual(1);

    // A post-overflow delta is dropped; the next keyframe recovers.
    pub.publishVideo(chunk(2), delta());
    pub.publishVideo(chunk(3), kf());
    pub.publishVideo(chunk(4), delta());
    await conn.releaseAll();

    // Continuity: after the overflow, publication resumes at a keyframe with
    // Object 0 on a fresh group — never a dependent as Object 0.
    const groups = new Map<bigint, bigint[]>();
    for (const s of conn.sends) {
      const arr = groups.get(s.streamId) ?? [];
      arr.push(s.objectId);
      groups.set(s.streamId, arr);
    }
    for (const objectIds of groups.values()) {
      expect(objectIds[0]).toBe(0n); // every subgroup starts at Object 0
      for (let i = 1; i < objectIds.length; i++) expect(objectIds[i]).toBe(objectIds[i - 1]! + 1n);
    }
    // The dropped post-overflow delta (payload 2) never went out.
    expect(conn.sends.some((s) => s.payload[0] === 2)).toBe(false);
    // Total sends stayed bounded (cap + recovery frames, not 500).
    expect(conn.sends.length).toBeLessThanOrEqual(15);
  });

  it('audio: sustained chunks far beyond the cap stay bounded, dropping the OLDEST', async () => {
    const conn = recordingConnection({ holdSends: true });
    const errors: string[] = [];
    const QUEUE_MAX = 8;
    const MAX_IN_FLIGHT = 4;
    const pub = makePublisher(conn, {
      audioQueueMax: QUEUE_MAX,
      audioMaxInFlight: MAX_IN_FLIGHT,
      onError: (ctx, err) => errors.push(`${ctx}: ${(err as Error).message}`),
    });
    pub.setAudioAlias(3n);

    pub.publishAudio(chunk(0), { timestampUs: 0 }); // held in flight
    await settle();
    for (let i = 1; i <= 300; i++) pub.publishAudio(new Uint8Array([i % 250]), { timestampUs: i });

    expect((pub as unknown as { audioQueue: unknown[] }).audioQueue.length).toBeLessThanOrEqual(QUEUE_MAX);
    expect(errors.some((e) => /audio queue overflow/.test(e))).toBe(true);

    await conn.releaseAll();
    // Bounded delivery: at most the concurrency cap plus one queue's worth
    // ever reaches the wire from a 300-chunk burst.
    expect(conn.sends.length).toBeLessThanOrEqual(QUEUE_MAX + MAX_IN_FLIGHT);
    // Recency policy: the LAST enqueued chunk survived the drops.
    expect(conn.sends[conn.sends.length - 1]!.payload[0]).toBe(300 % 250);
  });
});

describe('MediaPublisher — audio publication concurrency', () => {
  it('publishes independent audio chunks CONCURRENTLY (serializing them starves the live edge)', async () => {
    // Each audio chunk is its own group on its own stream, so there is no
    // ordering dependency forcing one in-flight operation. Serializing them
    // caps throughput at ~1/(open+send+close latency) per chunk, which is
    // far below the ~50 chunks/sec a 20ms opus encoder produces — observed
    // live as ~3x audio decimation against a real relay.
    const conn = recordingConnection({ holdSends: true });
    const pub = makePublisher(conn);
    pub.setAudioAlias(3n);

    for (let i = 0; i < 5; i++) pub.publishAudio(chunk(i), { timestampUs: i * 20_000 });
    await settle();

    // All five reached the wire concurrently rather than queueing behind one.
    expect(conn.sends).toHaveLength(5);
    expect(conn.opened).toHaveLength(5);
    // Group IDs stay unique and monotonic despite the concurrency.
    const groups = conn.opened.map((o) => o.groupId);
    expect(new Set(groups).size).toBe(5);
    for (let i = 1; i < groups.length; i++) expect(groups[i]).toBe(groups[i - 1]! + 1n);

    await conn.releaseAll();
    expect(conn.closed).toHaveLength(5); // every stream FINed
  });

  it('bounds audio concurrency: a sustained burst never exceeds the in-flight cap', async () => {
    const conn = recordingConnection({ holdSends: true });
    const pub = makePublisher(conn, { audioMaxInFlight: 4, audioQueueMax: 100 });
    pub.setAudioAlias(3n);

    for (let i = 0; i < 50; i++) pub.publishAudio(chunk(i), { timestampUs: i * 20_000 });
    await settle();

    // Concurrency is capped — this is backpressure, not an unbounded fan-out
    // of simultaneous streams.
    expect(conn.sends).toHaveLength(4);
    await conn.releaseAll();
    // The rest drained through as slots freed.
    expect(conn.sends.length).toBeGreaterThan(4);
  });

  it('drain() awaits every concurrent audio send in flight', async () => {
    const conn = recordingConnection({ holdSends: true });
    const pub = makePublisher(conn);
    pub.setAudioAlias(3n);
    for (let i = 0; i < 3; i++) pub.publishAudio(chunk(i), { timestampUs: i });
    await settle();

    pub.retire();
    let drained = false;
    const drainPromise = pub.drain().then(() => { drained = true; });
    await settle();
    expect(drained).toBe(false); // three sends still in flight

    await conn.releaseAll();
    await drainPromise;
    expect(drained).toBe(true);
  });
});

describe('MediaPublisher — wall-clock rebase', () => {
  it('anchors video and audio independently: a shared anchor would throw one track off', async () => {
    const conn = recordingConnection();
    const wall = 1_700_000_000_000_000;
    // Chrome hands the two tracks unrelated bases: boot-relative video,
    // context-relative audio. This is the case that broke rendering.
    const pub = makePublisher(conn, { draft: 18, wallClockUs: () => wall });
    pub.setVideoAlias(2n);
    pub.setAudioAlias(3n);
    pub.publishVideo(chunk(1), { isKeyframe: true, timestampUs: 208_027_000_000 });
    pub.publishAudio(chunk(2), { timestampUs: 107_000_000 });
    await settle();

    const profile = { wireProfile: locWireProfileForDraft(18) };
    const stamps = conn.sends.map((s) => parseLocHeaders(s.extensions!, profile).captureTimestamp!);
    // Both land on the wall clock despite bases ~208,000 s apart.
    for (const t of stamps) expect(t).toBe(BigInt(wall));
  });

  it('keeps spacing after the anchor rather than re-anchoring every chunk', async () => {
    const conn = recordingConnection();
    const wall = 1_700_000_000_000_000;
    const pub = makePublisher(conn, { draft: 18, wallClockUs: () => wall });
    pub.setVideoAlias(2n);
    pub.publishVideo(chunk(1), { isKeyframe: true, timestampUs: 5_000_000 });
    pub.publishVideo(chunk(2), { isKeyframe: false, timestampUs: 5_040_000 });
    await settle();

    const profile = { wireProfile: locWireProfileForDraft(18) };
    const stamps = conn.sends.map((s) => parseLocHeaders(s.extensions!, profile).captureTimestamp!);
    expect(stamps[1]! - stamps[0]!).toBe(40_000n);
  });

  it('measures what the first chunk cost the anchor, without changing a stamp', async () => {
    const conn = recordingConnection();
    // The first chunk arrives 500 ms late and the rest 10 ms, so the anchor banks 490 ms.
    const delaysUs = [500_000, ...Array.from({ length: 60 }, () => 10_000)];
    let i = 0;
    const base = 1_700_000_000_000_000;
    const reports: AnchorReport[] = [];
    const pub = makePublisher(conn, {
      draft: 18,
      wallClockUs: () => base + i * 40_000 + delaysUs[i]!,
      timeOriginUs: () => null,
      onAnchor: (r: AnchorReport) => reports.push(r),
    });
    pub.setVideoAlias(2n);
    for (; i < delaysUs.length; i++) {
      pub.publishVideo(chunk(i), { isKeyframe: i === 0, timestampUs: i * 40_000 });
      await settle();
    }

    expect(reports).toHaveLength(1);
    expect(reports[0]!.track).toBe('video');
    expect(reports[0]!.excessUs).toBe(490_000);
    // Spacing is untouched: the measurement does not move the anchor.
    const profile = { wireProfile: locWireProfileForDraft(18) };
    const stamps = conn.sends.map((s) => parseLocHeaders(s.extensions!, profile).captureTimestamp!);
    expect(stamps[1]! - stamps[0]!).toBe(40_000n);
  });

  it('omits the timeOrigin comparison where there is no performance timeline', async () => {
    const conn = recordingConnection();
    const reports: AnchorReport[] = [];
    const pub = makePublisher(conn, {
      draft: 18,
      wallClockUs: () => 1_700_000_000_000_000,
      timeOriginUs: () => null,
      onAnchor: (r: AnchorReport) => reports.push(r),
    });
    pub.setVideoAlias(2n);
    for (let n = 0; n < 60; n++) {
      pub.publishVideo(chunk(n), { isKeyframe: n === 0, timestampUs: n * 40_000 });
      await settle();
    }
    expect(reports[0]!.timeOriginDeltaUs).toBeUndefined();
  });
});

describe('MediaPublisher — subscription ended under us', () => {
  const ended = () => new MoqtConnectionError(
    'openSubgroup: the subscription for track alias 3 is terminated — no further objects (§10.11)',
    { errorSource: 'data' });

  it('retires the track instead of failing once per chunk', async () => {
    const conn = recordingConnection();
    let calls = 0;
    conn.openSubgroup = async () => { calls++; throw ended(); };
    const errors: string[] = [];
    const statuses: string[] = [];
    const pub = makePublisher(conn, {
      onError: (ctx) => errors.push(ctx),
      onStatus: (track, message) => statuses.push(`${track}: ${message}`),
    });
    pub.setAudioAlias(3n);
    for (let i = 0; i < 40; i++) pub.publishAudio(chunk(i), { timestampUs: i * 20_000 });
    await settle();

    // Bounded by the in-flight cap (8) — those were already launched when the
    // first failed. Without retiring, all forty would have failed.
    expect(calls).toBeLessThanOrEqual(8);
    expect(statuses).toEqual(['audio: SUBSCRIBE terminated (a send was refused); awaiting SUBSCRIBE']);
    expect(errors.filter((e) => e === 'audio publish')).toHaveLength(0);
    expect(pub.endedTracks).toContain('audio');
  });

  it('resumes when a new SUBSCRIBE assigns the alias again', async () => {
    const conn = recordingConnection();
    let fail = true;
    const realOpen = conn.openSubgroup.bind(conn);
    conn.openSubgroup = async (...args: Parameters<typeof realOpen>) => {
      if (fail) throw ended();
      return realOpen(...args);
    };
    const pub = makePublisher(conn, { onError: () => {} });
    pub.setAudioAlias(3n);
    pub.publishAudio(chunk(1), { timestampUs: 0 });
    await settle();
    expect(pub.endedTracks).toContain('audio');

    fail = false;
    pub.setAudioAlias(3n);              // the relay subscribed again
    pub.publishAudio(chunk(2), { timestampUs: 20_000 });
    await settle();
    expect(pub.endedTracks).not.toContain('audio');
    expect(conn.sends.length).toBeGreaterThan(0);
  });

  it('endTrack stops production, and the next keyframe opens a fresh subgroup on the new alias', async () => {
    const conn = recordingConnection();
    const errors: string[] = [];
    const pub = makePublisher(conn, { onError: (ctx) => errors.push(ctx) });
    pub.setVideoAlias(2n);
    pub.publishVideo(chunk(0), kf());
    pub.publishVideo(chunk(1), delta());
    await settle();
    const oldStream = conn.opened[0]!.streamId;

    pub.endTrack('video');
    pub.endTrack('video');
    pub.publishVideo(chunk(2), delta());   // nothing is produced while ended
    await settle();
    expect(errors).toEqual([]);            // the session logs the relay's cancel
    expect(pub.endedTracks).toEqual(['video']);
    expect(conn.sends).toHaveLength(2);

    pub.setVideoAlias(5n);
    pub.publishVideo(chunk(3), delta());   // a delta cannot start the new subscription
    pub.publishVideo(chunk(4), kf());
    await settle();
    expect(conn.opened).toHaveLength(2);
    expect(conn.opened[1]!.alias).toBe(5n);
    expect(conn.sends.slice(2).map((s) => [s.streamId, s.payload[0]]))
      .toEqual([[conn.opened[1]!.streamId, 4]]);
    expect(conn.closed).not.toContain(oldStream);   // the adapter already reset it
  });

  it('a cancellation error citing §5.1.1 is not taken as a Forward State 0 pause', async () => {
    const conn = recordingConnection();
    conn.openSubgroup = async () => {
      throw new MoqtConnectionError(
        'openSubgroup: subscription for track alias 2 was cancelled while opening the stream (§5.1.1)',
        { errorSource: 'data' });
    };
    const errors: string[] = [];
    const pub = makePublisher(conn, { onError: (ctx) => errors.push(ctx) });
    pub.setVideoAlias(2n);
    pub.publishVideo(chunk(0), kf());
    await settle();
    expect(pub.pausedTracks).toEqual([]);
    expect(errors).toEqual(['video publish']);
  });

  it('endTrack clears a pause, so a new SUBSCRIBE resumes at once', async () => {
    const conn = recordingConnection();
    const realSend = conn.sendObject.bind(conn);
    let forwarding = false;
    conn.sendObject = (sid, oid, payload, ext) => (forwarding
      ? realSend(sid, oid, payload, ext)
      : Promise.reject(new Error(
        `sendObject: stream ${String(sid)} belongs to a subscription with `
        + 'Forward State 0 — no Objects may be sent (§5.1)')));
    const pub = makePublisher(conn, { onError: () => {} });   // default probe interval
    pub.setVideoAlias(2n);
    pub.publishVideo(chunk(0), kf());
    await settle();
    expect(pub.pausedTracks).toEqual(['video']);

    pub.endTrack('video');
    forwarding = true;
    pub.setVideoAlias(5n);
    pub.publishVideo(chunk(1), kf());
    await settle();
    expect(pub.pausedTracks).toEqual([]);
    expect(conn.sends.map((s) => s.payload[0])).toEqual([1]);
  });
});

describe('MediaPublisher — audio over datagrams', () => {
  /** recordingConnection has no sendDatagram; add one that records. */
  function withDatagrams(conn: ReturnType<typeof recordingConnection>) {
    const sent: Array<{ alias: bigint; groupId: bigint; objectId: bigint;
      payload: Uint8Array; extensions?: Uint8Array | undefined }> = [];
    (conn as unknown as { sendDatagram: unknown }).sendDatagram = async (
      alias: bigint, groupId: bigint, objectId: bigint, payload: Uint8Array,
      opts?: { publisherPriority?: number; extensions?: Uint8Array },
    ) => { sent.push({ alias, groupId, objectId, payload, extensions: opts?.extensions }); };
    return sent;
  }

  it('sends audio as datagrams carrying LOC headers, opening no stream', async () => {
    const conn = recordingConnection();
    const sent = withDatagrams(conn);
    const pub = makePublisher(conn, { draft: 18, audioDatagrams: true });
    pub.setAudioAlias(3n);

    pub.publishAudio(chunk(0), { timestampUs: 1_000 });
    pub.publishAudio(chunk(1), { timestampUs: 21_000 });
    await settle();

    expect(sent).toHaveLength(2);
    // The stream path must not run at all — that is the churn being removed.
    expect(conn.opened).toHaveLength(0);
    expect(sent[0]!.alias).toBe(3n);
    // Audio is the sync master; without LOC headers the receiver has no
    // capture timestamp and never establishes a reference.
    expect(sent[0]!.extensions).toBeInstanceOf(Uint8Array);
    expect(sent[0]!.extensions!.byteLength).toBeGreaterThan(0);
    expect(sent[0]!.groupId).not.toBe(sent[1]!.groupId);
    expect(pub.audioChunkCount).toBe(2);
  });

  it('stays on streams when the draft is not 18', async () => {
    const conn = recordingConnection();
    const sent = withDatagrams(conn);
    const pub = makePublisher(conn, { draft: 16, audioDatagrams: true });
    pub.setAudioAlias(3n);

    pub.publishAudio(chunk(0), { timestampUs: 1_000 });
    await settle();

    expect(sent).toHaveLength(0);
    expect(conn.opened.length).toBeGreaterThan(0);
  });
});

describe('MediaPublisher — relay Forward State changes', () => {
  it('a pause stops production quietly and keeps the alias; a resume restarts video at a keyframe', async () => {
    const conn = recordingConnection();
    const errors: string[] = [];
    let keyframeRequests = 0;
    const pub = makePublisher(conn, {
      onError: (ctx) => errors.push(ctx),
      onKeyframeNeeded: () => { keyframeRequests++; },
      pauseProbeMs: 1,
    });
    pub.setVideoAlias(2n);
    const afterBind = keyframeRequests;
    pub.publishVideo(chunk(0), kf());
    await settle();

    pub.setForward('video', false);
    pub.publishVideo(chunk(1), delta());
    pub.publishVideo(chunk(2), kf());
    await new Promise((r) => setTimeout(r, 5));   // past any retry window
    pub.publishVideo(chunk(3), kf());
    await settle();
    expect(conn.sends.map((s) => s.payload[0])).toEqual([0]);
    expect(pub.videoAliasArmed).toBe(2n);
    expect(errors).toEqual([]);

    pub.setForward('video', true);
    expect(keyframeRequests).toBe(afterBind + 1);
    pub.publishVideo(chunk(4), delta());          // no reference after the gap
    pub.publishVideo(chunk(5), kf());
    await settle();
    expect(conn.sends.map((s) => s.payload[0])).toEqual([0, 5]);
  });

  it('reports the largest location sent per track', async () => {
    const conn = recordingConnection({ holdCloses: true });
    const pub = makePublisher(conn);
    expect(pub.largestLocation('video')).toBeNull();
    pub.setVideoAlias(2n);
    pub.publishVideo(chunk(0), kf());
    pub.publishVideo(chunk(1), delta());
    await settle();
    expect(pub.largestLocation('video')).toEqual({ group: conn.opened[0]!.groupId, object: 1n });

    pub.setAudioAlias(3n);
    pub.publishAudio(chunk(2), { timestampUs: 0 });
    pub.publishAudio(chunk(3), { timestampUs: 20_000 });
    await settle();
    const [earlier, later] = conn.opened.slice(1).map((o) => o.groupId);
    await conn.releaseLastClose();                // the later chunk finishes first
    expect(pub.largestLocation('audio')).toEqual({ group: later, object: 0n });
    await conn.releaseCloses();
    expect(pub.largestLocation('audio')).toEqual({ group: later, object: 0n });
    expect(earlier! < later!).toBe(true);
  });

  it('binding a video alias requests a keyframe, and a throwing hook is reported', () => {
    const errors: string[] = [];
    let calls = 0;
    const pub = makePublisher(recordingConnection(), {
      onError: (ctx) => errors.push(ctx),
      onKeyframeNeeded: () => { calls++; if (calls === 2) throw new Error('encoder closed'); },
    });
    pub.setVideoAlias(2n);
    expect(calls).toBe(1);
    expect(() => pub.setVideoAlias(5n)).not.toThrow();
    expect(errors).toEqual(['keyframe request']);
  });
});

describe('MediaPublisher — new group requests', () => {
  it('a request against a group minGroupMs old asks for a keyframe at once; repeats share it', async () => {
    let wall = 1_700_000_000_000_000;
    let keyframes = 0;
    const pub = makePublisher(recordingConnection(), {
      wallClockUs: () => wall, minGroupMs: 500, onKeyframeNeeded: () => { keyframes++; },
    });
    pub.setVideoAlias(2n);
    pub.publishVideo(chunk(0), kf());
    await settle();
    wall += 600_000;
    pub.requestNewGroup();
    pub.requestNewGroup();
    expect(keyframes).toBe(2);
    expect(pub.newGroupRequestCount).toBe(1);

    pub.publishVideo(chunk(1), kf(40_000));
    await settle();
    wall += 600_000;
    pub.requestNewGroup();
    expect(keyframes).toBe(3);
    expect(pub.newGroupRequestCount).toBe(2);
  });

  it('a request against a young group waits for minGroupMs; a keyframe meanwhile answers it', async () => {
    let keyframes = 0;
    const pub = makePublisher(recordingConnection(), {
      wallClockUs: () => 1_700_000_000_000_000, minGroupMs: 20, onKeyframeNeeded: () => { keyframes++; },
    });
    pub.setVideoAlias(2n);
    pub.publishVideo(chunk(0), kf());
    await settle();
    pub.requestNewGroup();
    expect(keyframes).toBe(1);
    await new Promise((r) => setTimeout(r, 30));
    expect(keyframes).toBe(2);
    expect(pub.newGroupRequestCount).toBe(1);

    pub.publishVideo(chunk(1), kf(40_000));
    await settle();
    pub.requestNewGroup();
    pub.publishVideo(chunk(2), kf(80_000));
    await settle();
    await new Promise((r) => setTimeout(r, 30));
    expect(keyframes).toBe(2);
    expect(pub.newGroupRequestCount).toBe(1);
  });

  it('retiring cancels a deferred request', async () => {
    let keyframes = 0;
    const pub = makePublisher(recordingConnection(), {
      wallClockUs: () => 1_700_000_000_000_000, minGroupMs: 10, onKeyframeNeeded: () => { keyframes++; },
    });
    pub.setVideoAlias(2n);
    pub.publishVideo(chunk(0), kf());
    await settle();
    pub.requestNewGroup();
    pub.retire();
    await new Promise((r) => setTimeout(r, 20));
    expect(keyframes).toBe(1);
    expect(pub.newGroupRequestCount).toBe(0);
  });

  it('rejects an invalid minGroupMs', () => {
    expect(() => makePublisher(recordingConnection(), { minGroupMs: -1 })).toThrow(/minGroupMs/);
  });
});

describe('MediaPublisher — capture clock drift', () => {
  it('reports each track\'s drift against its anchor once per period', async () => {
    let wallUs = 1_700_000_000_000_000;
    const reports: DriftReport[] = [];
    const pub = makePublisher(recordingConnection(), {
      draft: 18,
      wallClockUs: () => wallUs,
      driftReportMs: 10,
      onDrift: (r) => reports.push(r),
    });
    pub.setVideoAlias(2n);
    // The wall clock advances 1000 µs a frame, the video stamps 990: the
    // video clock runs slow by 10 µs a frame.
    for (let k = 0; k <= 20; k++) {
      wallUs = 1_700_000_000_000_000 + k * 1_000;
      pub.publishVideo(chunk(k), { isKeyframe: k === 0, timestampUs: k * 990 });
      await settle();
    }
    expect(reports).toHaveLength(2);
    // The first period includes the anchoring chunk; the second starts at
    // frame 11, where the stamps are 110 µs behind.
    expect(reports[1]).toEqual({ elapsedMs: 20, videoUs: 110, audioUs: null, followUs: null });
  });

  it('carries the wall clock\'s divergence from the monotonic clock into both tracks\' stamps', async () => {
    const conn = recordingConnection();
    const epoch = 1_700_000_000_000_000;
    let monoUs = epoch;
    let wallUs = epoch;
    const pub = makePublisher(conn, {
      draft: 18, wallClockUs: () => wallUs, monotonicNowUs: () => monoUs,
    });
    pub.setVideoAlias(2n);
    pub.setAudioAlias(3n);
    // Both tracks keep the monotonic clock, from unrelated bases; after the
    // anchor the wall clock runs 2 ms ahead of it.
    for (let k = 0; k < 400; k++) {
      monoUs = epoch + k * 20_000;
      wallUs = monoUs + (k === 0 ? 0 : 2_000);
      pub.publishVideo(chunk(k), { isKeyframe: k === 0, timestampUs: 500_000_000 + k * 20_000 });
      pub.publishAudio(chunk(k), { timestampUs: 7_000_000 + k * 20_000 });
      await settle();
    }
    const profile = { wireProfile: locWireProfileForDraft(18) };
    const last = conn.sends.slice(-2).map((x) => parseLocHeaders(x.extensions!, profile).captureTimestamp!);
    const expected = epoch + 399 * 20_000 + 2_000;
    for (const t of last) expect(Math.abs(Number(t) - expected)).toBeLessThanOrEqual(1);
  });

  it('reports the follow it applied and the drift left after it', async () => {
    const epoch = 1_700_000_000_000_000;
    let monoUs = epoch;
    let wallUs = epoch;
    const reports: DriftReport[] = [];
    const pub = makePublisher(recordingConnection(), {
      draft: 18,
      wallClockUs: () => wallUs,
      monotonicNowUs: () => monoUs,
      driftReportMs: 1_000,
      onDrift: (r) => reports.push(r),
    });
    pub.setVideoAlias(2n);
    for (let k = 0; k <= 200; k++) {
      monoUs = epoch + k * 20_000;
      wallUs = monoUs + (k === 0 ? 0 : 2_000);
      pub.publishVideo(chunk(k), { isKeyframe: k === 0, timestampUs: k * 20_000 });
      await settle();
    }
    const r = reports.at(-1)!;
    expect(r.followUs!).toBeGreaterThan(1_900);
    expect(Math.abs(r.videoUs!)).toBeLessThan(100);
  });

  it('a throwing drift sink is reported, not raised', async () => {
    let wallUs = 1_700_000_000_000_000;
    const errors: string[] = [];
    const pub = makePublisher(recordingConnection(), {
      draft: 18,
      wallClockUs: () => wallUs,
      driftReportMs: 1,
      onDrift: () => { throw new Error('sink bug'); },
      onError: (ctx) => errors.push(ctx),
    });
    pub.setVideoAlias(2n);
    for (let k = 0; k <= 2; k++) {
      wallUs += 1_000;
      pub.publishVideo(chunk(k), { isKeyframe: k === 0, timestampUs: k * 1_000 });
      await settle();
    }
    expect(errors).toContain('drift report');
  });
});

describe('MediaPublisher — a new subscription replacing an old one', () => {
  const terminated = (sid: unknown) => new MoqtConnectionError(
    `sendObject: stream ${String(sid)} belongs to a terminated subscription — no further Objects (§10.11)`,
    { errorSource: 'data' });

  it('a new video alias does not inherit the old subgroup, so its errors cannot retire video', async () => {
    const conn = recordingConnection();
    const realSend = conn.sendObject.bind(conn);
    let oldStream: bigint | null = null;
    conn.sendObject = (sid, oid, payload, ext) => (sid === oldStream
      ? Promise.reject(terminated(sid))
      : realSend(sid, oid, payload, ext));
    const pub = makePublisher(conn, { onError: () => {} });
    pub.setVideoAlias(2n);
    pub.publishVideo(chunk(0), kf());
    await settle();
    oldStream = conn.opened[0]!.streamId;            // its subscription has since ended

    pub.setVideoAlias(5n);                           // the relay subscribed again
    pub.publishVideo(chunk(1), delta());             // no reference on the new alias
    pub.publishVideo(chunk(2), kf());
    await settle();
    expect(pub.endedTracks).toEqual([]);
    expect(pub.videoAliasArmed).toBe(5n);
    expect(conn.opened.at(-1)!.alias).toBe(5n);
    expect(conn.sends.at(-1)!.payload[0]).toBe(2);
  });

  it('a late video error from the previous subscription is ignored', async () => {
    const conn = recordingConnection({ holdSends: true });
    const pub = makePublisher(conn, { onError: () => {} });
    pub.setVideoAlias(2n);
    pub.publishVideo(chunk(0), kf());
    await settle();

    pub.setVideoAlias(5n);
    await conn.rejectAllPending(terminated(conn.opened[0]!.streamId));
    expect(pub.endedTracks).toEqual([]);
    expect(pub.videoAliasArmed).toBe(5n);
  });

  it('a late audio error from the previous subscription is ignored', async () => {
    const conn = recordingConnection({ holdSends: true });
    const pub = makePublisher(conn, { onError: () => {} });
    pub.setAudioAlias(3n);
    pub.publishAudio(chunk(0), { timestampUs: 0 });
    await settle();

    pub.setAudioAlias(7n);
    await conn.rejectAllPending(terminated(conn.opened[0]!.streamId));
    expect(pub.endedTracks).toEqual([]);
    expect(pub.audioAliasArmed).toBe(7n);
  });
});

describe('MediaPublisher — status reports', () => {
  it('a send that lands while the relay holds Forward State 0 does not announce a resume', async () => {
    const conn = recordingConnection();
    const realSend = conn.sendObject.bind(conn);
    let land!: () => void;
    let sends = 0;
    conn.sendObject = (sid, oid, payload, ext) => {
      sends++;
      if (sends === 1) {
        return new Promise<void>((resolve) => { land = () => { void realSend(sid, oid, payload, ext).then(resolve); }; });
      }
      return Promise.reject(new Error(
        `sendObject: stream ${String(sid)} belongs to a subscription with Forward State 0 — no Objects may be sent (§5.1)`));
    };
    const statuses: string[] = [];
    const pub = makePublisher(conn, { onStatus: (track, message) => statuses.push(`${track}: ${message}`) });
    pub.setAudioAlias(3n);
    pub.publishAudio(chunk(0), { timestampUs: 0 });        // stays in flight
    pub.publishAudio(chunk(1), { timestampUs: 20_000 });   // refused at Forward State 0
    await settle();
    pub.setForward('audio', false);                        // the relay's REQUEST_UPDATE
    land();
    await settle();
    expect(statuses).toEqual(['audio: Forward State 0 (a send was refused)']);
  });
});
