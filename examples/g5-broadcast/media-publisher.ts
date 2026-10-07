/**
 * Media publication for the broadcast example, DOM-free so the concurrency
 * and wire contracts are unit-testable.
 *
 * WebCodecs chunk callbacks are synchronous and void — they must never be
 * given an async handler directly, because under backpressure several
 * handler invocations would interleave at their first await: two video
 * chunks could read the same object ID before either increments it, and a
 * keyframe's stream rotation could close a subgroup a delta frame is still
 * writing to. Publication is therefore an explicit BOUNDED QUEUE per media
 * type with a single-flight pump: `publish*` are synchronous enqueues, and
 * all state (object IDs, group IDs, the open subgroup) is read and written
 * only inside the pump, so IDs are unique and ordered by construction.
 *
 * Backpressure is bounded, with codec-safe overflow behavior:
 * - VIDEO: a full queue means continuity is lost — queued dependents are
 *   invalidated (dropped) and further dependents are dropped until the next
 *   keyframe opens a fresh group at Object 0.
 * - AUDIO: chunks are independently decodable (one per group), so the
 *   OLDEST queued chunk is dropped, favoring live latency.
 *
 * Wire behavior binds to the NEGOTIATED draft supplied at construction:
 * LOC extension properties use `locWireProfileForDraft(draft)` (draft-18's
 * vi64 codec diverges from the QUIC varint), and on draft-18 every subgroup
 * this original publisher opens sets the mandatory FIRST_OBJECT bit
 * (draft-18 §2.2); draft-14/16 bytes are unchanged.
 *
 * One instance is bound to ONE connection for its whole life — a broadcast
 * generation. A restart builds a fresh publisher (aliases start unset, so
 * nothing can be sent through a stale alias before the relay subscribes),
 * and `retire()` makes the old generation inert: queued work is dropped,
 * in-flight work is awaited by `drain()`, and late enqueues are ignored —
 * an old generation can never write to a replacement session.
 */
import { encodeLocHeaders, locWireProfileForDraft } from '@openmoq/loc';
import type { DraftVersion } from '@openmoq/transport';
import { buildChunk } from '../shared/browser/cmaf-mux.js';

/** The subset of MoqtConnection the media publication path uses. */
export interface MediaPublishConnection {
  openSubgroup(
    alias: unknown,
    groupId: unknown,
    subgroupId: unknown,
    options: Record<string, unknown>,
  ): Promise<bigint>;
  sendObject(streamId: bigint, objectId: unknown, payload: Uint8Array, extensions?: Uint8Array): Promise<void>;
  closeSubgroup(streamId: bigint): Promise<void>;
  /** draft-18 OBJECT_DATAGRAM. Absent without datagram support. */
  sendDatagram?(
    trackAlias: bigint,
    groupId: bigint,
    objectId: bigint,
    payload: Uint8Array,
    opts?: { publisherPriority?: number; extensions?: Uint8Array },
  ): Promise<void>;
}

export interface VideoChunkMeta {
  isKeyframe: boolean;
  /** Capture timestamp in microseconds (WebCodecs chunk timestamp). */
  timestampUs: number;
  /** Codec description (decoder config) to ride as the LOC videoConfig. */
  videoConfig?: Uint8Array;
  /** Frame duration in microseconds, when the encoder reports one. */
  durationUs?: number;
}

export interface AudioChunkMeta {
  /** Capture timestamp in microseconds (WebCodecs chunk timestamp). */
  timestampUs: number;
  /** Chunk duration in microseconds, when the encoder reports one. */
  durationUs?: number;
}

/** CMAF track IDs; they match the init segments the catalog carries. */
export const CMAF_VIDEO_TRACK_ID = 1;
export const CMAF_AUDIO_TRACK_ID = 2;
/** Fallbacks when the encoder reports no duration: 30 fps, a 20 ms Opus frame. */
const DEFAULT_VIDEO_FRAME_US = 33_333;
const DEFAULT_AUDIO_FRAME_US = 20_000;

/** The capture-clock anchor in use, measured against the best offset observed. */
export interface AnchorReport {
  readonly track: 'video' | 'audio';
  /** The offset actually in use: the first chunk's `now - timestamp`. */
  readonly anchorUs: number;
  /** The lowest `now - timestamp` seen over the settling window. */
  readonly minObservedUs: number;
  /** anchorUs - minObservedUs: what the first chunk's delay cost this track. */
  readonly excessUs: number;
  /** anchorUs - performance.timeOrigin; absent without a performance timeline.
   *  Small means the capture timestamps are on that timeline. */
  readonly timeOriginDeltaUs?: number;
}

/**
 * Each track's capture clock against the wall clock over one period: the lowest
 * `now - timestamp` seen, minus the track's anchor. The minimum strips per-chunk
 * encode and queue delay, so growth across reports is the track's clock running
 * slow against the wall clock, and the video − audio gap is the A/V offset a
 * receiver syncing on these stamps inherits.
 */
export interface DriftReport {
  /** Wall-clock time since the first chunk was anchored. */
  readonly elapsedMs: number;
  /** Stamp drift after the clock follow; null for a track with no chunk in the period. */
  readonly videoUs: number | null;
  readonly audioUs: number | null;
  /** Wall-clock divergence from the monotonic clock carried into the stamps
   *  since the anchor; null when not following. */
  readonly followUs: number | null;
}

export interface MediaPublisherOptions {
  /** Wraps a bigint as the wire integer type (the example passes `varint`). */
  wrapInt: (n: bigint) => unknown;
  /** NEGOTIATED MoQT draft — selects the LOC wire profile and, on draft-18,
   *  the mandatory FIRST_OBJECT subgroup bit. Typed (not `number`) so an
   *  unsupported draft cannot silently inherit draft-16 LOC behavior. */
  draft: DraftVersion;
  /**
   * Wall clock in microseconds since the Unix epoch, anchoring each track's
   * first chunk timestamp. Injectable for tests. Default `Date.now() * 1000`.
   */
  wallClockUs?: () => number;
  /**
   * Wall-clock microseconds of the page's time origin, or null where there is
   * no performance timeline. Injectable for tests. Default `performance.timeOrigin`.
   */
  timeOriginUs?: () => number | null;
  /**
   * The monotonic clock the capture timestamps keep, in epoch microseconds
   * (`performance.timeOrigin + performance.now()`). Its divergence from
   * {@link wallClockUs} is carried into the stamps; null disables that.
   * Default: the performance clock, or null when `wallClockUs` is injected.
   */
  monotonicNowUs?: () => number | null;
  /** Called once per track, after ANCHOR_SETTLE_OBSERVATIONS chunks, with the
   *  anchor measured against the best offset seen. */
  onAnchor?: (report: AnchorReport) => void;
  /** Called every `driftReportMs` of wall clock with both tracks' drift. */
  onDrift?: (report: DriftReport) => void;
  /** Drift report period (default 60000ms); 0 disables. */
  driftReportMs?: number;
  /** Failure sink — publication errors are contained, never unhandled. */
  onError?: (context: string, err: unknown) => void;
  /** Counter sink for UI updates: called after each published object. */
  onCounts?: (videoFrames: number, audioChunks: number) => void;
  /** Queue bounds (frames/chunks). Defaults: video 60, audio 50. */
  videoQueueMax?: number;
  audioQueueMax?: number;
  /**
   * Maximum audio publications in flight at once (default 8). Audio chunks
   * are independent groups on independent streams, so they are published
   * CONCURRENTLY: serializing an open+send+close round trip per 20ms chunk
   * caps throughput far below the encoder's output rate. This bounds the
   * fan-out so concurrency is still backpressure, not unlimited streams.
   */
  audioMaxInFlight?: number;
  /** How long a Forward State 0 pause suppresses production before one chunk
   *  is re-attempted (default 1000ms). Injectable for tests. */
  pauseProbeMs?: number;
  /** Publish audio as OBJECT_DATAGRAMs rather than a subgroup stream per
   *  chunk: no retransmission, no per-chunk stream churn. draft-18 only. */
  audioDatagrams?: boolean;
  /**
   * Object payload format. `loc` (default): the encoded frame. `cmaf`: one
   * CMAF chunk (moof + mdat) per frame, decode time in microseconds so it
   * matches the capture timestamp property (CMSF-01 §3.3).
   */
  packaging?: 'loc' | 'cmaf';
  /** Video needs a keyframe now: a new subscription or a resume. The page
   *  asks its encoder for one. */
  onKeyframeNeeded?: () => void;
  /** A track's MoQT state changed in a way only a send revealed: Forward
   *  State, or a terminated subscription. Not an error. */
  onStatus?: (track: 'video' | 'audio', message: string) => void;
}

/** Drafts whose wire behavior this publisher implements explicitly. */
const SUPPORTED_DRAFTS: readonly DraftVersion[] = [14, 16, 18];

/** Default Forward State 0 pause before one chunk is re-attempted. */
const PAUSE_PROBE_MS = 1_000;

/** Validate a queue bound: NaN/Infinity would disable backpressure entirely
 *  and a non-positive or fractional cap has no coherent meaning. */
function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer, got ${value}`);
  }
}

interface QueuedVideo { data: Uint8Array; meta: VideoChunkMeta }
interface QueuedAudio { data: Uint8Array; meta: AudioChunkMeta }

export class MediaPublisher {
  private readonly connection: MediaPublishConnection;
  private readonly wrapInt: (n: bigint) => unknown;
  private readonly draft: DraftVersion;
  private readonly wallClockUs: () => number;
  /** Observations per track before the anchor's error is reported. */
  private static readonly ANCHOR_SETTLE_OBSERVATIONS = 60;
  private readonly timeOriginUs: () => number | null;
  private readonly monotonicNowUs: () => number | null;
  private readonly onAnchor: ((report: AnchorReport) => void) | null;
  /**
   * Offset from each track's WebCodecs timestamp base to the wall clock, set at the
   * track's first chunk. Fixed, because the stamps' spacing is the media timeline the
   * receiver paces on; per track, because Chrome's video and audio bases are unrelated
   * (boot-relative vs context-relative). The first chunk's delay is banked; see AnchorReport.
   * Only the wall clock's divergence from the monotonic clock is added later.
   */
  private videoTsOffsetUs: number | null = null;
  private audioTsOffsetUs: number | null = null;
  /** Smoothed wall − monotonic clock gap, averaging out Date.now()'s 1 ms grain. */
  private clockGapUs: number | null = null;
  /** clockGapUs at each track's anchor. */
  private videoGapAtAnchorUs: number | null = null;
  private audioGapAtAnchorUs: number | null = null;
  private static readonly CLOCK_GAP_SMOOTHING = 0.02;
  /** Lowest `now - timestamp` seen per track: the anchor we could have had. */
  private readonly minObservedUs = new Map<string, number>();
  private readonly anchorObservations = new Map<string, number>();
  private readonly anchorReported = new Set<string>();
  private readonly onDrift: ((report: DriftReport) => void) | null;
  private readonly driftReportMs: number;
  /** Wall clock (µs) at the first anchored chunk, and at the current period's start. */
  private driftStartUs: number | null = null;
  private driftPeriodStartUs = 0;
  /** Lowest `now - timestamp` per track in the current period. */
  private readonly driftPeriodMin = new Map<string, number>();
  private readonly onError: (context: string, err: unknown) => void;
  private readonly onCounts: ((v: number, a: number) => void) | null;
  private readonly videoQueueMax: number;
  private readonly audioQueueMax: number;
  private readonly audioMaxInFlight: number;
  private readonly pauseProbeMs: number;
  private readonly audioDatagrams: boolean;
  private readonly cmaf: boolean;
  /** mfhd sequence numbers, per CMAF track. */
  private cmafVideoSequence = 0;
  private cmafAudioSequence = 0;
  /** Previous video decode time, for a duration when the encoder gives none. */
  private lastVideoCaptureUs: bigint | null = null;
  private readonly onKeyframeNeeded: (() => void) | null;
  private readonly onStatus: ((track: 'video' | 'audio', message: string) => void) | null;
  /** Largest (group, object) sent per track; Largest Location for a resume. */
  private videoLargest: { group: bigint; object: bigint } | null = null;
  private audioLargest: { group: bigint; object: bigint } | null = null;

  private videoAlias: bigint | null = null;
  private audioAlias: bigint | null = null;

  private videoGroupId: bigint;
  private videoObjectId = 0n;
  private videoStreamId: bigint | null = null;
  /** The alias the open video subgroup was opened under. */
  private videoStreamAlias: bigint | null = null;
  private audioGroupId: bigint;

  private videoFrames = 0;
  private audioChunks = 0;
  /** Payload bytes accepted for send, per track. Rates are a caller-side delta. */
  private videoBytes = 0;
  private audioBytes = 0;
  private videoKeyframes = 0;

  /** Explicit bounded queues + single-flight pumps (the serialization). */
  private readonly videoQueue: QueuedVideo[] = [];
  private readonly audioQueue: QueuedAudio[] = [];
  private videoPump: Promise<void> = Promise.resolve();
  private videoPumping = false;
  /** In-flight audio publications (bounded by {@link audioMaxInFlight}). */
  private readonly audioInFlight = new Set<Promise<void>>();

  /** Video continuity lost (queue overflow): dependents are invalid until
   *  the next keyframe opens a fresh group at Object 0. */
  private videoContinuityLost = false;
  private audioOverflowing = false;

  private stopped = false;
  private readonly ended = new Set<string>();
  /** Tracks the relay has stopped forwarding (Forward State 0). */
  private readonly paused = new Set<string>();
  /** Tracks the relay reported paused; only its resume clears them. */
  private readonly forwardPaused = new Set<string>();
  /** Pause episodes already reported, so a probe failure is not re-announced. */
  private readonly pauseReported = new Set<string>();

  /** Every subgroup close ever initiated — drain() waits for all of them. */
  private readonly pendingCloses = new Set<Promise<void>>();

  constructor(connection: MediaPublishConnection, options: MediaPublisherOptions) {
    // Validate before any state exists: a NaN/Infinity bound would silently
    // disable backpressure, and an unsupported draft would silently emit
    // draft-16 LOC bytes on a session that negotiated something else.
    if (!SUPPORTED_DRAFTS.includes(options.draft)) {
      throw new Error(`unsupported draft ${String(options.draft)} — supported: ${SUPPORTED_DRAFTS.join(', ')}`);
    }
    if (options.videoQueueMax !== undefined) assertPositiveInteger(options.videoQueueMax, 'videoQueueMax');
    if (options.audioQueueMax !== undefined) assertPositiveInteger(options.audioQueueMax, 'audioQueueMax');
    if (options.audioMaxInFlight !== undefined) assertPositiveInteger(options.audioMaxInFlight, 'audioMaxInFlight');
    this.connection = connection;
    this.wrapInt = options.wrapInt;
    this.draft = options.draft;
    this.wallClockUs = options.wallClockUs ?? (() => Date.now() * 1000);
    this.timeOriginUs = options.timeOriginUs
      ?? (() => (typeof performance === 'undefined' ? null : performance.timeOrigin * 1000));
    this.monotonicNowUs = options.monotonicNowUs
      ?? (options.wallClockUs !== undefined || typeof performance === 'undefined'
        ? () => null
        : () => (performance.timeOrigin + performance.now()) * 1000);
    this.onAnchor = options.onAnchor ?? null;
    if (options.driftReportMs !== undefined
        && !(Number.isFinite(options.driftReportMs) && options.driftReportMs >= 0)) {
      throw new Error(`driftReportMs must be a non-negative number, got ${options.driftReportMs}`);
    }
    this.onDrift = options.onDrift ?? null;
    this.driftReportMs = options.driftReportMs ?? 60_000;
    this.onError = options.onError ?? (() => {});
    this.onCounts = options.onCounts ?? null;
    this.videoQueueMax = options.videoQueueMax ?? 60;
    this.audioQueueMax = options.audioQueueMax ?? 50;
    this.pauseProbeMs = options.pauseProbeMs ?? PAUSE_PROBE_MS;
    // draft-18 only: sendDatagram rejects on 14/16, so never arm it there.
    this.audioDatagrams = options.audioDatagrams === true && options.draft === 18;
    this.cmaf = options.packaging === 'cmaf';
    this.audioMaxInFlight = options.audioMaxInFlight ?? 8;
    this.onKeyframeNeeded = options.onKeyframeNeeded ?? null;
    this.onStatus = options.onStatus ?? null;
    this.videoGroupId = BigInt(Date.now());
    this.audioGroupId = BigInt(Date.now()) + 1_000_000n; // offset to avoid collision
  }

  /** Bind the relay-subscribed aliases (from the accepted SUBSCRIBEs). A new
   *  video subscription starts at a keyframe, requested now. */
  setVideoAlias(alias: bigint): void {
    this.videoAlias = alias;
    this.ended.delete('video');
    this.requestKeyframe();
  }
  setAudioAlias(alias: bigint): void { this.audioAlias = alias; this.ended.delete('audio'); }

  /**
   * The relay changed a track's Forward State (§5.1). A pause drops the queue
   * and suppresses production until the resume; video then restarts at a
   * keyframe, requested at once.
   */
  setForward(track: 'video' | 'audio', forward: boolean): void {
    if (!forward) {
      this.forwardPaused.add(track);
      if (track === 'video') {
        this.videoQueue.length = 0;
        this.videoContinuityLost = true;
      } else {
        this.audioQueue.length = 0;
      }
      return;
    }
    this.forwardPaused.delete(track);
    this.paused.delete(track);
    this.pauseReported.delete(track);
    if (track === 'video') {
      this.videoContinuityLost = true;
      this.requestKeyframe();
    }
  }

  /** Largest (group, object) sent on a track, or null before its first. */
  largestLocation(track: 'video' | 'audio'): { group: bigint; object: bigint } | null {
    return track === 'video' ? this.videoLargest : this.audioLargest;
  }

  /** The keyframe hook is application code: a throw is reported, not raised. */
  private requestKeyframe(): void {
    try {
      this.onKeyframeNeeded?.();
    } catch (err) {
      this.report('keyframe request', err);
    }
  }

  /** The alias each track currently publishes to, or null when unarmed. */
  get videoAliasArmed(): bigint | null { return this.videoAlias; }
  get audioAliasArmed(): bigint | null { return this.audioAlias; }

  /** Tracks whose subscription ended, for the UI. */
  get endedTracks(): readonly string[] { return [...this.ended]; }

  /** Tracks the relay is not currently forwarding, for the UI. */
  get pausedTracks(): readonly string[] { return [...this.paused]; }

  /**
   * Forward State 0: the relay wants no Objects for now. Distinct from
   * retirement — the alias MUST be kept, because a resume flips Forward back
   * to 1 without a new SUBSCRIBE. Queued frames are dropped and production is
   * suppressed until a probe re-attempts one chunk.
   */
  private pauseTrack(track: 'video' | 'audio', err: unknown): boolean {
    // Not the bare "§5.1": cancellation errors cite §5.1.1.
    if (!String((err as Error)?.message ?? '').includes('Forward State 0')) return false;
    if (track === 'video') {
      this.videoQueue.length = 0;
      // Resume at a keyframe: dependents published across the gap are useless.
      this.videoContinuityLost = true;
    } else {
      this.audioQueue.length = 0;
    }
    this.paused.add(track);
    // The relay's REQUEST_UPDATE, when it arrived, already announced this.
    if (!this.pauseReported.has(track) && !this.forwardPaused.has(track)) {
      this.pauseReported.add(track);
      this.status(track, 'Forward State 0 (a send was refused)');
    }
    setTimeout(() => { this.paused.delete(track); }, this.pauseProbeMs);
    return true;
  }

  /** A chunk got through: the pause episode, if any, is over. */
  private noteSent(track: 'video' | 'audio'): void {
    // A send already in flight when the relay paused proves nothing.
    if (this.forwardPaused.has(track)) return;
    if (!this.pauseReported.delete(track)) return;
    this.paused.delete(track);
    this.status(track, 'Forward State 1 (a send went through)');
  }

  /**
   * The track's subscription ended — the viewer left or the relay tore it
   * down. Drop the queue and clear the alias, which the publish guards treat
   * as "do not produce"; a later SUBSCRIBE calls setVideoAlias/setAudioAlias
   * and production resumes. The adapter has already reset the subscription's
   * streams, so the open video subgroup is forgotten, not closed, and the next
   * keyframe opens a fresh one.
   */
  endTrack(track: 'video' | 'audio'): void {
    if (track === 'video') {
      this.videoAlias = null;
      this.videoQueue.length = 0;
      this.videoStreamId = null;
      this.videoStreamAlias = null;
    } else {
      this.audioAlias = null;
      this.audioQueue.length = 0;
    }
    this.paused.delete(track);
    this.forwardPaused.delete(track);
    this.pauseReported.delete(track);
    this.ended.add(track);
  }

  /** A §10.11 publish error: the subscription ended before we were told. */
  private retireTrack(track: 'video' | 'audio', err: unknown): boolean {
    if (!String((err as Error)?.message ?? '').includes('§10.11')) return false;
    if (!this.ended.has(track)) {
      this.status(track, 'SUBSCRIBE terminated (a send was refused); awaiting SUBSCRIBE');
    }
    this.endTrack(track);
    return true;
  }

  /** The status sink is application code: a throw is reported, not raised. */
  private status(track: 'video' | 'audio', message: string): void {
    try {
      this.onStatus?.(track, message);
    } catch (err) {
      this.report('status', err);
    }
  }

  get frameCount(): number { return this.videoFrames; }
  get audioChunkCount(): number { return this.audioChunks; }
  get videoByteCount(): number { return this.videoBytes; }
  get audioByteCount(): number { return this.audioBytes; }
  get keyframeCount(): number { return this.videoKeyframes; }
  /** Enqueued but not yet sent, against videoQueueMax / audioQueueMax. */
  get videoQueueDepth(): number { return this.videoQueue.length; }
  get audioQueueDepth(): number { return this.audioQueue.length; }
  get queueLimits(): { video: number; audio: number } {
    return { video: this.videoQueueMax, audio: this.audioQueueMax };
  }

  /**
   * Enqueue one encoded video chunk. Synchronous and void — safe to call
   * from a WebCodecs output callback. Dropped if the publisher is stopped
   * or the video alias is not yet bound (never a stale-alias send).
   */
  publishVideo(data: Uint8Array, meta: VideoChunkMeta): void {
    if (this.stopped || this.videoAlias === null
        || this.paused.has('video') || this.forwardPaused.has('video')) return;
    if (this.videoQueue.length >= this.videoQueueMax) {
      // Overflow: the queued dependents can never all be delivered in time —
      // continuity is lost. Invalidate the whole backlog and recover at the
      // next keyframe (fresh group, Object 0). Report once per episode.
      this.videoQueue.length = 0;
      if (!this.videoContinuityLost) {
        this.videoContinuityLost = true;
        this.report('video publish', new Error(
          `video queue overflow (${this.videoQueueMax} frames): dropping until the next keyframe`));
      }
    }
    if (this.videoContinuityLost) {
      if (!meta.isKeyframe) return; // dependents are invalid without their base
      this.videoContinuityLost = false;
    }
    this.videoQueue.push({ data, meta });
    this.pumpVideo();
  }

  /** Enqueue one encoded audio chunk (same contract as {@link publishVideo}). */
  publishAudio(data: Uint8Array, meta: AudioChunkMeta): void {
    if (this.stopped || this.audioAlias === null
        || this.paused.has('audio') || this.forwardPaused.has('audio')) return;
    if (this.audioQueue.length >= this.audioQueueMax) {
      // Audio chunks are independently decodable — drop the OLDEST to keep
      // the live edge. Report once per overflow episode.
      this.audioQueue.shift();
      if (!this.audioOverflowing) {
        this.audioOverflowing = true;
        this.report('audio publish', new Error(
          `audio queue overflow (${this.audioQueueMax} chunks): dropping oldest`));
      }
    }
    this.audioQueue.push({ data, meta });
    this.pumpAudio();
  }

  /**
   * Synchronously retire this broadcast generation: further enqueues are
   * ignored and all queued work is dropped. Retirement never blocks — the
   * caller drives the graceful-drain / hard-close sequence (see
   * BroadcastSession.shutdown) and then awaits {@link drain}.
   */
  retire(): void {
    this.stopped = true;
    this.videoQueue.length = 0;
    this.audioQueue.length = 0;
  }

  /**
   * Await everything this generation started: both pumps and every tracked
   * subgroup close, then close (FIN) the open video subgroup. After
   * resolution, no publication from this generation can reach the
   * connection. Never rejects (all failures are contained best-effort).
   */
  async drain(): Promise<void> {
    await this.videoPump;
    while (this.audioInFlight.size > 0) {
      await Promise.all([...this.audioInFlight]);
    }
    while (this.pendingCloses.size > 0) {
      await Promise.all([...this.pendingCloses]);
    }
    if (this.videoStreamId !== null) {
      const sid = this.videoStreamId;
      this.videoStreamId = null;
      try { await this.connection.closeSubgroup(sid); } catch { /* already closed */ }
    }
  }

  /** Convenience for callers with no stalled-send hazard: retire + drain. */
  async stop(): Promise<void> {
    this.retire();
    await this.drain();
  }

  /** The error sink is application code — a throw from it must not reject
   *  or poison a publication pump, nor make drain()/stop() reject. */
  private report(context: string, err: unknown): void {
    try {
      this.onError(context, err);
    } catch { /* contained: the sink cannot poison the chain */ }
  }

  /** Initiate a subgroup close and TRACK it — drain() awaits every close,
   *  so none is fire-and-forget. Close failures are best-effort. */
  private trackClose(streamId: bigint): Promise<void> {
    const close = this.connection.closeSubgroup(streamId).then(() => {}, () => {});
    this.pendingCloses.add(close);
    void close.then(() => this.pendingCloses.delete(close));
    return close;
  }

  /** draft-18 §2.2: the original publisher MUST set FIRST_OBJECT on every
   *  new subgroup. The option is d18-only (the adapter rejects it on 14/16). */
  private subgroupOptions(priority: number): Record<string, unknown> {
    return {
      hasExtensions: true,
      endOfGroup: true,
      publisherPriority: priority,
      ...(this.draft === 18 ? { firstObject: true } : {}),
    };
  }

  // ─── Single-flight pumps (only ever one in flight per media type) ────

  private pumpVideo(): void {
    if (this.videoPumping) return;
    this.videoPumping = true;
    this.videoPump = (async () => {
      try {
        while (this.videoQueue.length > 0 && !this.stopped) {
          const item = this.videoQueue.shift()!;
          const alias = this.videoAlias;
          try {
            await this.sendVideoChunk(item.data, item.meta);
            this.noteSent('video');
          } catch (err) {
            // An error from an earlier subscription says nothing about this one.
            if (alias !== this.videoAlias) continue;
            if (this.pauseTrack('video', err)) break;
            if (this.retireTrack('video', err)) break;
            this.report('video publish', err);
          }
        }
      } finally {
        this.videoPumping = false;
      }
    })();
  }

  /**
   * Dispatch queued audio up to the in-flight cap. Group IDs are allocated
   * synchronously here, so concurrent publications still carry unique,
   * monotonic group IDs.
   */
  private pumpAudio(): void {
    while (this.audioQueue.length > 0 && !this.stopped && this.audioInFlight.size < this.audioMaxInFlight) {
      const item = this.audioQueue.shift()!;
      const groupId = ++this.audioGroupId;
      const alias = this.audioAlias;
      const inFlight = (async () => {
        try {
          await this.sendAudioChunk(item.data, item.meta, groupId);
          this.noteSent('audio');
        } catch (err) {
          // An error from an earlier subscription says nothing about this one.
          if (alias !== this.audioAlias) return;
          if (!this.pauseTrack('audio', err) && !this.retireTrack('audio', err)) {
            this.report('audio publish', err);
          }
        }
      })();
      this.audioInFlight.add(inFlight);
      void inFlight.then(() => {
        this.audioInFlight.delete(inFlight);
        // A freed slot may admit the next queued chunk.
        if (!this.stopped) this.pumpAudio();
      });
    }
  }

  /**
   * Rebase a WebCodecs chunk timestamp to Unix-epoch microseconds. The first
   * chunk of each track anchors to the wall clock; later chunks keep their
   * spacing relative to it. Without this the stamp carries a browser-defined
   * base, and a receiver using audio as its sync master computes video render
   * times against an unrelated origin.
   * @see draft-ietf-moq-loc-04 §2.3.1.1 (Timestamp without Timescale = µs since epoch)
   */
  private toWallClockUs(track: 'video' | 'audio', timestampUs: number): bigint {
    const key = track === 'video' ? 'videoTsOffsetUs' : 'audioTsOffsetUs';
    const gapKey = track === 'video' ? 'videoGapAtAnchorUs' : 'audioGapAtAnchorUs';
    const nowUs = this.wallClockUs();
    const gapUs = this.updateClockGap(nowUs);
    const observed = nowUs - timestampUs;
    if (this[key] === null) {
      this[key] = observed;
      this[gapKey] = gapUs;
    }
    // Capture timestamps keep the monotonic clock; receivers compare stamps with
    // their wall clock. Carry the clocks' divergence since this track's anchor.
    const anchorGap = this[gapKey];
    const followUs = gapUs !== null && anchorGap !== null ? gapUs - anchorGap : null;
    this.observeAnchor(track, observed);
    this.observeDrift(track, observed - (followUs ?? 0), nowUs, followUs);
    return BigInt(Math.round(timestampUs + this[key]! + (followUs ?? 0)));
  }

  /** Smoothed wall − monotonic gap, or null without a monotonic clock. */
  private updateClockGap(nowUs: number): number | null {
    const monoUs = this.monotonicNowUs();
    if (monoUs === null) return null;
    const rawUs = nowUs - monoUs;
    this.clockGapUs = this.clockGapUs === null
      ? rawUs
      : this.clockGapUs + (rawUs - this.clockGapUs) * MediaPublisher.CLOCK_GAP_SMOOTHING;
    return this.clockGapUs;
  }

  /** Keep each track's lowest `now - stamp` per period and report it
   *  against the track's anchor when the period ends. */
  private observeDrift(
    track: 'video' | 'audio', observedUs: number, nowUs: number, followUs: number | null,
  ): void {
    if (!this.onDrift || this.driftReportMs <= 0) return;
    if (this.driftStartUs === null) {
      this.driftStartUs = nowUs;
      this.driftPeriodStartUs = nowUs;
    }
    const min = this.driftPeriodMin.get(track);
    if (min === undefined || observedUs < min) this.driftPeriodMin.set(track, observedUs);
    if (nowUs - this.driftPeriodStartUs < this.driftReportMs * 1000) return;

    const drift = (t: 'video' | 'audio'): number | null => {
      const periodMin = this.driftPeriodMin.get(t);
      const anchor = t === 'video' ? this.videoTsOffsetUs : this.audioTsOffsetUs;
      return periodMin === undefined || anchor === null ? null : periodMin - anchor;
    };
    const report: DriftReport = {
      elapsedMs: (nowUs - this.driftStartUs) / 1000,
      videoUs: drift('video'),
      audioUs: drift('audio'),
      followUs,
    };
    this.driftPeriodMin.clear();
    this.driftPeriodStartUs = nowUs;
    try {
      this.onDrift(report);
    } catch (err) {
      this.report('drift report', err);
    }
  }

  /**
   * Track the lowest `now - timestamp` per track and, after ANCHOR_SETTLE_OBSERVATIONS
   * chunks, report the anchor against it once. Measures only: the anchor and the
   * emitted stamps do not change.
   */
  private observeAnchor(track: 'video' | 'audio', observedUs: number): void {
    if (this.anchorReported.has(track)) return;
    const min = this.minObservedUs.get(track);
    if (min === undefined || observedUs < min) this.minObservedUs.set(track, observedUs);
    const n = (this.anchorObservations.get(track) ?? 0) + 1;
    this.anchorObservations.set(track, n);
    if (n < MediaPublisher.ANCHOR_SETTLE_OBSERVATIONS) return;

    this.anchorReported.add(track);
    const anchorUs = track === 'video' ? this.videoTsOffsetUs! : this.audioTsOffsetUs!;
    const minObservedUs = this.minObservedUs.get(track)!;
    const origin = this.timeOriginUs();
    this.onAnchor?.({
      track,
      anchorUs,
      minObservedUs,
      excessUs: anchorUs - minObservedUs,
      ...(origin === null ? {} : { timeOriginDeltaUs: anchorUs - origin }),
    });
  }

  /** Draft-18 gives LOC-01's 0x02/0x04 Track scope, so it carries LOC-04's ids. */
  private locOptions(): { wireProfile: ReturnType<typeof locWireProfileForDraft>; locVersion: 1 | 4 } {
    return { wireProfile: locWireProfileForDraft(this.draft), locVersion: this.draft === 18 ? 4 : 1 };
  }

  private videoExtensions(meta: VideoChunkMeta, captureUs: bigint): Uint8Array | undefined {
    // CMAF carries its own decode time and sync flags; only the capture time rides along.
    if (this.cmaf) {
      return encodeLocHeaders({ captureTimestamp: captureUs }, this.locOptions());
    }
    return encodeLocHeaders({
      captureTimestamp: captureUs,
      videoFrameMarking: {
        independent: meta.isKeyframe,
        // No temporal layers, so every P-frame is a reference for the next.
        discardable: false,
        baseLayerSync: false,
        startOfFrame: true,
        endOfFrame: true,
        temporalId: 0,
      },
      ...(meta.videoConfig ? { videoConfig: meta.videoConfig } : {}),
    }, this.locOptions());
  }

  private async sendVideoChunk(data: Uint8Array, meta: VideoChunkMeta): Promise<void> {
    if (meta.isKeyframe) {
      // New group per keyframe. The previous subgroup has no further writers
      // (the pump is the only one), so its close needs no await — but it
      // IS tracked, so drain() waits for it. The slot is cleared BEFORE the
      // new open: a failed open must leave NO stream, not revive the old one.
      if (this.videoStreamId !== null) {
        const oldStreamId = this.videoStreamId;
        this.videoStreamId = null;
        this.trackClose(oldStreamId);
      }
      this.videoGroupId++;
      this.videoObjectId = 0n;
      // endOfGroup: true — required for one-subgroup-per-GOP LOC video.
      // Without this, receivers cannot distinguish normal group completion
      // from an incomplete group and will wait for the intra-group timeout.
      const alias = this.videoAlias!;
      this.videoStreamId = await this.connection.openSubgroup(
        this.wrapInt(alias), this.wrapInt(this.videoGroupId), this.wrapInt(0n),
        this.subgroupOptions(128),
      );
      this.videoStreamAlias = alias;
    }
    // A subgroup opened under an earlier subscription's alias cannot carry
    // this one's frames.
    if (this.videoStreamId !== null && this.videoStreamAlias !== this.videoAlias) {
      const stale = this.videoStreamId;
      this.videoStreamId = null;
      this.trackClose(stale);
    }
    // No open subgroup — either pre-first-keyframe, or the group was retired
    // by a failure. Dependent frames are dropped until the next keyframe.
    if (this.videoStreamId === null) return;

    const captureUs = this.toWallClockUs('video', meta.timestampUs);
    const payload = this.cmaf ? this.cmafVideoChunk(data, meta, captureUs) : data;
    try {
      await this.connection.sendObject(
        this.videoStreamId, this.wrapInt(this.videoObjectId), payload, this.videoExtensions(meta, captureUs));
    } catch (err) {
      // LOC: Object 0 of a subgroup must be the independent frame. After a
      // failed (or ambiguous) send the group is unusable — retire it, so
      // deltas drop until the next keyframe opens a fresh group at Object 0.
      const broken = this.videoStreamId;
      this.videoStreamId = null;
      this.trackClose(broken);
      throw err;
    }
    this.videoLargest = { group: this.videoGroupId, object: this.videoObjectId };
    this.videoObjectId++;
    this.videoFrames++;
    this.videoBytes += data.byteLength;
    if (meta.isKeyframe) this.videoKeyframes++;
    this.onCounts?.(this.videoFrames, this.audioChunks);
  }

  private async sendAudioChunk(chunk: Uint8Array, meta: AudioChunkMeta, groupId: bigint): Promise<void> {
    const captureUs = this.toWallClockUs('audio', meta.timestampUs);
    const extensions = encodeLocHeaders({
      captureTimestamp: captureUs,
    }, this.locOptions());
    const data = this.cmaf
      ? buildChunk({
        trackId: CMAF_AUDIO_TRACK_ID,
        sequence: ++this.cmafAudioSequence,
        baseDecodeTime: captureUs,
        duration: meta.durationUs && meta.durationUs > 0 ? meta.durationUs : DEFAULT_AUDIO_FRAME_US,
        keyframe: true,
        data: chunk,
      })
      : chunk;
    // Audio: one object per group (independently decodable, LOC §4.1);
    // audio gets higher priority (lower value) than video.
    if (this.audioDatagrams && this.connection.sendDatagram) {
      await this.connection.sendDatagram(
        this.audioAlias!, groupId, 0n, data,
        { publisherPriority: 64, ...(extensions ? { extensions } : {}) },
      );
      this.noteAudioSent(chunk.byteLength, groupId);
      return;
    }
    const streamId = await this.connection.openSubgroup(
      this.wrapInt(this.audioAlias!), this.wrapInt(groupId), this.wrapInt(0n),
      this.subgroupOptions(64),
    );
    try {
      await this.connection.sendObject(streamId, this.wrapInt(0n), data, extensions);
    } catch (err) {
      this.trackClose(streamId); // best-effort terminal cleanup for the failed stream
      throw err;
    }
    await this.trackClose(streamId);
    this.noteAudioSent(chunk.byteLength, groupId);
  }

  /** One CMAF chunk around an encoded video frame, decode time = capture time. */
  private cmafVideoChunk(data: Uint8Array, meta: VideoChunkMeta, captureUs: bigint): Uint8Array {
    const last = this.lastVideoCaptureUs;
    this.lastVideoCaptureUs = captureUs;
    const sinceLast = last === null ? 0 : Number(captureUs - last);
    const duration = meta.durationUs && meta.durationUs > 0 ? meta.durationUs
      : sinceLast > 0 && sinceLast < 1_000_000 ? sinceLast : DEFAULT_VIDEO_FRAME_US;
    return buildChunk({
      trackId: CMAF_VIDEO_TRACK_ID,
      sequence: ++this.cmafVideoSequence,
      baseDecodeTime: captureUs,
      duration,
      keyframe: meta.isKeyframe,
      data,
    });
  }

  /** Accounting shared by the stream and datagram audio paths. Concurrent
   *  publications finish out of order, so the largest group is a max. */
  private noteAudioSent(bytes: number, groupId: bigint): void {
    if (this.audioLargest === null || groupId > this.audioLargest.group) {
      this.audioLargest = { group: groupId, object: 0n };
    }
    this.audioChunks++;
    this.audioBytes += bytes;
    this.onCounts?.(this.videoFrames, this.audioChunks);
    if (this.audioQueue.length < this.audioQueueMax) this.audioOverflowing = false;
  }
}
