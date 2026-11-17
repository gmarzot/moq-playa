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
import type { LocHeaders } from '@openmoq/loc';
import type { DraftVersion } from '@openmoq/transport';
import { isRequestStreamDraft } from '@openmoq/transport';
import { buildChunk } from '../shared/browser/cmaf-mux.js';
import {
  LocmafEncoder, LocmafGroupState, parseLocmafTrackContext, serializeLocmafObject,
  type LocmafTrackContext,
} from '@openmoq/locmaf';

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
/** Room left under MSE's discontinuity threshold (decode delta > 2 x last frame duration). */
const DECODE_DELTA_MARGIN_US = 100n;
/** A longer decode gap is a pause, resumed at a keyframe; shorter ones are clamped. */
const DECODE_CLAMP_MAX_US = 1_000_000n;

/** Longest LOCMAF audio group when no video group starts meanwhile. */
const LOCMAF_AUDIO_GROUP_MAX_US = 2_000_000n;

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
   * matches the capture timestamp property (CMSF-01 §3.3). `locmaf`: that
   * chunk as a LOCMAF Object (draft-einarsson-moq-locmaf-01); subgroups only.
   */
  packaging?: 'loc' | 'cmaf' | 'locmaf';
  /**
   * LOC objects for receivers without a catalog: each also carries the codec
   * string (0x11, not in LOC-04) and the audio config; video keeps its video
   * config. Timestamps stay wall clock (no Timescale, LOC-04 §2.3.1.1).
   * With CMAF packaging, the CMAF header (init segment) instead rides the first
   * object of a group, at most once a second per track.
   */
  selfDescribing?: { videoCodec: string; audioCodec?: string; audioConfig?: Uint8Array };
  /** LOC objects carry Timescale 1000000 with the Timestamp, for players that
   *  require one. The stamps then read as media time (LOC-04 §2.3.1.2), so
   *  receivers lose end-to-end latency. */
  locTimescale?: boolean;
  /** The CMAF init segments, once built; `locmaf` encodes against them. */
  cmafInit?: () => { videoInit: Uint8Array; audioInit?: Uint8Array } | undefined;
  /** Video needs a keyframe now: a new subscription or a resume. The page
   *  asks its encoder for one. */
  onKeyframeNeeded?: () => void;
  /** Youngest video group a NEW_GROUP_REQUEST may end, in ms (default 1000). */
  minGroupMs?: number;
  /** A track's MoQT state changed in a way only a send revealed: Forward
   *  State, or a terminated subscription. Not an error. */
  onStatus?: (track: 'video' | 'audio', message: string) => void;
}

/** Drafts whose wire behavior this publisher implements explicitly. */
const SUPPORTED_DRAFTS: readonly DraftVersion[] = [14, 16, 18, 22];

/** Codec string property (proposed for LOC; odd id, bytes). */
const LOC_PROP_CODECSTRING = 0x11n;
const MICROS_PER_SECOND = 1_000_000n;
/** Shortest gap between in-band CMAF headers on one track. */
const CMAF_HEADER_REPEAT_US = 1_000_000n;

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
/** One accepted subscription a track is served on. */
interface Outlet {
  /** Open subgroup (the video group, or the LOCMAF audio group); null until the next group starts. */
  streamId: bigint | null;
  /** Forward State (§5.1), from the relay's REQUEST_UPDATE. */
  forward: boolean;
  /** A send was refused with Forward State 0: skipped until the probe clears it. */
  refused: boolean;
}
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
  private readonly locmaf: boolean;
  private readonly cmafInit: MediaPublisherOptions['cmafInit'];
  private readonly selfDescribing: MediaPublisherOptions['selfDescribing'];
  private readonly cmafHeaderInBand: boolean;
  /** Capture time of each track's last in-band CMAF header. */
  private readonly cmafHeaderSentUs: { video: bigint | null; audio: bigint | null } = { video: null, audio: null };
  private readonly locTimescale: boolean;
  private readonly locmafEncoder = new LocmafEncoder();
  private readonly locmafContexts = new Map<'video' | 'audio', LocmafTrackContext>();
  /** LOCMAF chaining state of the open video group. */
  private videoLocmafState = new LocmafGroupState();
  /** LOCMAF headers sent: full, or delta against the previous object in the group. */
  private readonly locmafHeaderCounts = { full: 0, delta: 0 };
  /** mfhd sequence numbers, per CMAF track. */
  private cmafVideoSequence = 0;
  private cmafAudioSequence = 0;
  /** Previous video decode time, for a duration when the encoder gives none. */
  private lastVideoCaptureUs: bigint | null = null;
  /** Recent video capture intervals (µs), for the CMAF frame duration. */
  private readonly videoIntervalsUs: number[] = [];
  /** Decode time and duration of the previous CMAF video chunk. */
  private lastVideoDecode: { decodeUs: bigint; durationUs: number } | null = null;
  private readonly onKeyframeNeeded: (() => void) | null;
  private readonly minGroupMs: number;
  /** Wall-clock ms at which the open video group started. */
  private videoGroupStartMs: number | null = null;
  /** A requested new group is due or deferred; the next keyframe clears it. */
  private newGroupPending = false;
  private newGroupTimer: ReturnType<typeof setTimeout> | null = null;
  private newGroupsOnRequest = 0;
  private readonly onStatus: ((track: 'video' | 'audio', message: string) => void) | null;
  /** Largest (group, object) sent per track; Largest Location for a resume. */
  private videoLargest: { group: bigint; object: bigint } | null = null;
  private audioLargest: { group: bigint; object: bigint } | null = null;

  /** Each track's accepted subscriptions, by alias. Every Object goes to each one (§3.1). */
  private readonly outlets: Record<'video' | 'audio', Map<bigint, Outlet>> = { video: new Map(), audio: new Map() };

  private videoGroupId: bigint;
  private videoObjectId = 0n;
  private audioGroupId: bigint;
  /** LOCMAF: whether an audio group is open, its next object, and the video group it started under. */
  private audioGroupOpen = false;
  private audioObjectId = 0n;
  private audioStreamVideoGroup: bigint | null = null;
  private audioGroupStartUs = 0n;
  private audioLocmafState = new LocmafGroupState();
  /** LOCMAF: where each track's decode timeline continues. */
  private readonly nextDecodeUs: { video: bigint | null; audio: bigint | null } = { video: null, audio: null };

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
  /** LOCMAF audio is serial: a group's objects go in order on one subgroup. */
  private audioPump: Promise<void> = Promise.resolve();
  private audioPumping = false;

  /** Video continuity lost (queue overflow): dependents are invalid until
   *  the next keyframe opens a fresh group at Object 0. */
  private videoContinuityLost = false;
  private audioOverflowing = false;

  private stopped = false;
  private readonly ended = new Set<string>();
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
    if (options.minGroupMs !== undefined
        && !(Number.isFinite(options.minGroupMs) && options.minGroupMs >= 0)) {
      throw new Error(`minGroupMs must be a non-negative number, got ${options.minGroupMs}`);
    }
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
    this.locmaf = options.packaging === 'locmaf';
    this.cmaf = options.packaging === 'cmaf' || this.locmaf;
    this.cmafInit = options.cmafInit;
    this.locTimescale = options.locTimescale === true
      && (options.packaging === undefined || options.packaging === 'loc');
    this.selfDescribing = options.packaging === undefined || options.packaging === 'loc'
      ? options.selfDescribing
      : undefined;
    this.cmafHeaderInBand = options.packaging === 'cmaf' && options.selfDescribing !== undefined;
    // Draft 18 and later: sendDatagram rejects on 14/16, so never arm it there.
    // LOCMAF is carried on subgroups only.
    this.audioDatagrams = options.audioDatagrams === true && isRequestStreamDraft(options.draft) && !this.locmaf;
    this.audioMaxInFlight = options.audioMaxInFlight ?? 8;
    this.onKeyframeNeeded = options.onKeyframeNeeded ?? null;
    this.minGroupMs = options.minGroupMs ?? 1_000;
    this.onStatus = options.onStatus ?? null;
    this.videoGroupId = BigInt(Date.now());
    this.audioGroupId = BigInt(Date.now()) + 1_000_000n; // offset to avoid collision
  }

  /** Serve an accepted subscription on `alias`, beside any the track already has.
   *  A new video subscription starts at a keyframe, requested now. */
  addVideoAlias(alias: bigint): void {
    this.addOutlet('video', alias);
    this.requestKeyframe();
  }
  addAudioAlias(alias: bigint): void { this.addOutlet('audio', alias); }

  private addOutlet(track: 'video' | 'audio', alias: bigint): void {
    this.outlets[track].set(alias, { streamId: null, forward: true, refused: false });
    this.ended.delete(track);
  }

  /** One subscription ended. The adapter has reset its streams, so its open
   *  subgroup is forgotten, not closed. The track ends with its last one. */
  removeAlias(track: 'video' | 'audio', alias: bigint): void {
    if (!this.outlets[track].delete(alias)) return;
    if (this.outlets[track].size === 0) this.endTrack(track);
  }

  /** The aliases a track is served on, for the UI and tests. */
  aliasesOf(track: 'video' | 'audio'): bigint[] { return [...this.outlets[track].keys()]; }

  /**
   * The relay changed one subscription's Forward State (§5.1). With none left
   * forwarding, the queue is dropped and production stops until a resume. A
   * resumed subscription restarts at the next group; for video, a keyframe is
   * requested at once.
   */
  setForward(track: 'video' | 'audio', alias: bigint, forward: boolean): void {
    const outlet = this.outlets[track].get(alias);
    if (outlet === undefined) return;
    const before = this.deliverable(track);
    outlet.forward = forward;
    if (!forward) {
      if (before && !this.deliverable(track)) this.dropQueue(track);
      return;
    }
    outlet.refused = false;
    this.pauseReported.delete(track);
    // Its open group went on without it: it rejoins at the next one.
    this.closeOutletStream(outlet);
    if (track === 'video') {
      if (!before) this.videoContinuityLost = true;
      this.requestKeyframe();
    }
  }

  private static isDeliverable(outlet: Outlet): boolean { return outlet.forward && !outlet.refused; }

  /** Some subscription of the track takes Objects now. */
  private deliverable(track: 'video' | 'audio'): boolean {
    for (const outlet of this.outlets[track].values()) if (MediaPublisher.isDeliverable(outlet)) return true;
    return false;
  }

  /** Nothing can be delivered: drop the queue; video resumes at a keyframe. */
  private dropQueue(track: 'video' | 'audio'): void {
    if (track === 'video') {
      this.videoQueue.length = 0;
      this.videoContinuityLost = true;
    } else {
      this.audioQueue.length = 0;
    }
  }

  private closeOutletStream(outlet: Outlet): void {
    if (outlet.streamId === null) return;
    const streamId = outlet.streamId;
    outlet.streamId = null;
    this.trackClose(streamId);
  }

  /** Largest (group, object) sent on a track, or null before its first. */
  largestLocation(track: 'video' | 'audio'): { group: bigint; object: bigint } | null {
    return track === 'video' ? this.videoLargest : this.audioLargest;
  }

  /**
   * A subscriber asked for a new video group (NEW_GROUP_REQUEST). The keyframe
   * is requested once the open group is minGroupMs old; requests until the
   * next keyframe share it.
   */
  requestNewGroup(): void {
    if (this.stopped || this.newGroupPending) return;
    this.newGroupPending = true;
    const ageMs = this.videoGroupStartMs === null
      ? Infinity : this.wallClockUs() / 1000 - this.videoGroupStartMs;
    const waitMs = this.minGroupMs - ageMs;
    if (waitMs <= 0) {
      this.startRequestedGroup();
      return;
    }
    this.newGroupTimer = setTimeout(() => {
      this.newGroupTimer = null;
      this.startRequestedGroup();
    }, waitMs);
  }

  private startRequestedGroup(): void {
    if (this.stopped) return;
    this.newGroupsOnRequest++;
    this.requestKeyframe();
  }

  /** The keyframe hook is application code: a throw is reported, not raised. */
  private requestKeyframe(): void {
    try {
      this.onKeyframeNeeded?.();
    } catch (err) {
      this.report('keyframe request', err);
    }
  }

  /** Tracks whose subscription ended, for the UI. */
  get endedTracks(): readonly string[] { return [...this.ended]; }

  /** Tracks held by a refused send (Forward State 0), for the UI. */
  get pausedTracks(): readonly string[] {
    return (['video', 'audio'] as const).filter((track) => !this.deliverable(track)
      && [...this.outlets[track].values()].some((outlet) => outlet.refused));
  }

  /**
   * Forward State 0: the relay wants no Objects on this subscription for now.
   * Distinct from retirement: the alias MUST be kept, because a resume flips
   * Forward back to 1 without a new SUBSCRIBE. The subscription is skipped
   * until a probe re-attempts it; with none left deliverable the queue is
   * dropped and the pause reported once.
   */
  private refuseOutlet(track: 'video' | 'audio', outlet: Outlet, err: unknown): boolean {
    // Not the bare "§5.1": cancellation errors cite §5.1.1.
    if (!String((err as Error)?.message ?? '').includes('Forward State 0')) return false;
    const before = this.deliverable(track);
    outlet.refused = true;
    if (before && !this.deliverable(track)) this.dropQueue(track);
    // The relay's REQUEST_UPDATE, when it arrived, already announced this.
    if (!this.deliverable(track) && outlet.forward && !this.pauseReported.has(track)) {
      this.pauseReported.add(track);
      this.status(track, 'Forward State 0 (a send was refused)');
    }
    setTimeout(() => { outlet.refused = false; }, this.pauseProbeMs);
    return true;
  }

  /** A send went through: the pause episode, if any, is over. */
  private noteSent(track: 'video' | 'audio', outlet: Outlet): void {
    // A send already in flight when the relay paused proves nothing.
    if (!outlet.forward) return;
    if (!this.pauseReported.delete(track)) return;
    this.status(track, 'Forward State 1 (a send went through)');
  }

  /**
   * The track's subscriptions all ended: the viewers left or the relay tore
   * them down. Drop the queue and the subscriptions, which the publish guards
   * treat as "do not produce"; a later SUBSCRIBE adds one and production
   * resumes. The adapter has already reset their streams, so open subgroups
   * are forgotten, not closed, and the next group opens fresh ones.
   */
  endTrack(track: 'video' | 'audio'): void {
    this.outlets[track].clear();
    if (track === 'video') this.videoQueue.length = 0;
    else {
      this.audioQueue.length = 0;
      this.audioGroupOpen = false;
    }
    this.pauseReported.delete(track);
    this.ended.add(track);
  }

  /** A §10.11 publish error: this subscription ended before we were told. */
  private endOutlet(track: 'video' | 'audio', alias: bigint, err: unknown): boolean {
    if (!String((err as Error)?.message ?? '').includes('§10.11')) return false;
    this.outlets[track].delete(alias);
    if (this.outlets[track].size === 0) {
      if (!this.ended.has(track)) {
        this.status(track, 'SUBSCRIBE terminated (a send was refused); awaiting SUBSCRIBE');
      }
      this.endTrack(track);
    }
    return true;
  }

  /** A publication to one subscription failed; the others are unaffected. */
  private outletFailed(track: 'video' | 'audio', alias: bigint, outlet: Outlet, err: unknown): void {
    if (this.outlets[track].get(alias) !== outlet) return; // that subscription is already gone
    if (this.refuseOutlet(track, outlet, err) || this.endOutlet(track, alias, err)) return;
    this.report(`${track} publish`, err);
  }

  /** The subscriptions that take Objects now, with their aliases. */
  private deliverableOutlets(track: 'video' | 'audio'): Array<[bigint, Outlet]> {
    return [...this.outlets[track]].filter(([, outlet]) => MediaPublisher.isDeliverable(outlet));
  }

  /** Open a new group's subgroup on each subscription in `targets`. */
  private async openOutletStreams(
    track: 'video' | 'audio', targets: Array<[bigint, Outlet]>, groupId: bigint, priority: number,
  ): Promise<void> {
    const outlets = this.outlets[track];
    await Promise.all(targets.map(async ([alias, outlet]) => {
      try {
        const streamId = await this.connection.openSubgroup(
          this.wrapInt(alias), this.wrapInt(groupId), this.wrapInt(0n), this.subgroupOptions(priority));
        if (outlets.get(alias) === outlet && outlet.streamId === null) outlet.streamId = streamId;
        else this.trackClose(streamId);
      } catch (err) {
        this.outletFailed(track, alias, outlet, err);
      }
    }));
  }

  /** Send one Object on each ready subscription's open subgroup. True if any took it. */
  private async sendToOutlets(
    track: 'video' | 'audio', ready: Array<[bigint, Outlet]>, objectId: bigint,
    payload: Uint8Array, extensions: Uint8Array | undefined,
  ): Promise<boolean> {
    let sent = false;
    await Promise.all(ready.map(async ([alias, outlet]) => {
      const streamId = outlet.streamId!;
      try {
        await this.connection.sendObject(streamId, this.wrapInt(objectId), payload, extensions);
        sent = true;
        this.noteSent(track, outlet);
      } catch (err) {
        // The group is unusable on this subscription: it waits for the next one.
        if (outlet.streamId === streamId) this.closeOutletStream(outlet);
        this.outletFailed(track, alias, outlet, err);
      }
    }));
    return sent;
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
  /** Keyframes requested to answer a NEW_GROUP_REQUEST. */
  get newGroupRequestCount(): number { return this.newGroupsOnRequest; }
  /** Enqueued but not yet sent, against videoQueueMax / audioQueueMax. */
  get videoQueueDepth(): number { return this.videoQueue.length; }
  get audioQueueDepth(): number { return this.audioQueue.length; }
  get queueLimits(): { video: number; audio: number } {
    return { video: this.videoQueueMax, audio: this.audioQueueMax };
  }

  /**
   * Enqueue one encoded video chunk. Synchronous and void — safe to call
   * from a WebCodecs output callback. Dropped if the publisher is stopped
   * or no subscription takes Objects now.
   */
  publishVideo(data: Uint8Array, meta: VideoChunkMeta): void {
    if (this.stopped || !this.deliverable('video')) return;
    if (this.videoQueue.length >= this.videoQueueMax) {
      // Overflow: the queued dependents can never all be delivered in time —
      // continuity is lost. Invalidate the whole backlog and recover at the
      // next keyframe (fresh group, Object 0). Report once per episode.
      this.videoQueue.length = 0;
      if (!this.videoContinuityLost) {
        this.videoContinuityLost = true;
        this.report('video publish', new Error(
          `video queue overflow (${this.videoQueueMax} frames): dropping until the next keyframe`));
        this.requestKeyframe();
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
    if (this.stopped || !this.deliverable('audio')) return;
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
    if (this.newGroupTimer !== null) clearTimeout(this.newGroupTimer);
    this.newGroupTimer = null;
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
    await this.audioPump;
    while (this.audioInFlight.size > 0) {
      await Promise.all([...this.audioInFlight]);
    }
    while (this.pendingCloses.size > 0) {
      await Promise.all([...this.pendingCloses]);
    }
    for (const track of ['video', 'audio'] as const) {
      for (const outlet of this.outlets[track].values()) {
        if (outlet.streamId === null) continue;
        const sid = outlet.streamId;
        outlet.streamId = null;
        try { await this.connection.closeSubgroup(sid); } catch { /* already closed */ }
      }
    }
    this.audioGroupOpen = false;
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
      ...(isRequestStreamDraft(this.draft) ? { firstObject: true } : {}),
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
          try {
            await this.sendVideoChunk(item.data, item.meta);
          } catch (err) {
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
    if (this.locmaf) {
      this.pumpAudioGrouped();
      return;
    }
    while (this.audioQueue.length > 0 && !this.stopped && this.audioInFlight.size < this.audioMaxInFlight) {
      const item = this.audioQueue.shift()!;
      const groupId = ++this.audioGroupId;
      const inFlight = (async () => {
        try {
          await this.sendAudioChunk(item.data, item.meta, groupId);
        } catch (err) {
          this.report('audio publish', err);
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

  /** LOCMAF audio, one chunk at a time (same failure handling as {@link pumpAudio}). */
  private pumpAudioGrouped(): void {
    if (this.audioPumping) return;
    this.audioPumping = true;
    this.audioPump = (async () => {
      try {
        while (this.audioQueue.length > 0 && !this.stopped) {
          const item = this.audioQueue.shift()!;
          try {
            await this.sendAudioGrouped(item.data, item.meta);
          } catch (err) {
            this.report('audio publish', err);
          }
        }
      } finally {
        this.audioPumping = false;
      }
    })();
  }

  /**
   * LOCMAF decode time: where the track's previous chunk ended, so the delta
   * header chains; capture time instead when that is over half a frame away.
   * The capture timestamp property still carries the capture time.
   */
  private onDecodeTimeline(track: 'video' | 'audio', captureUs: bigint, durationUs: number): bigint {
    const next = this.nextDecodeUs[track];
    const half = BigInt(Math.floor(durationUs / 2));
    const decodeUs = next !== null && captureUs - next <= half && next - captureUs <= half ? next : captureUs;
    this.nextDecodeUs[track] = decodeUs + BigInt(durationUs);
    return decodeUs;
  }

  /**
   * MSE drops video to the next keyframe when a decode delta exceeds twice the
   * previous frame's duration, which one skipped camera frame plus jitter does.
   * The delta stays just under that; after a longer capture stall the decode
   * timeline catches up over the following frames. Pauses (over 1 s) keep their gap.
   */
  private clampVideoDecode(decodeUs: bigint): bigint {
    const prev = this.lastVideoDecode;
    if (prev === null || decodeUs - prev.decodeUs > DECODE_CLAMP_MAX_US) return decodeUs;
    const limit = prev.decodeUs + 2n * BigInt(prev.durationUs) - DECODE_DELTA_MARGIN_US;
    return decodeUs > limit ? limit : decodeUs;
  }

  /**
   * One LOCMAF audio chunk on the open audio group. A group starts with the
   * next video group (joint tune-in), a new subscription, a failure, or after
   * {@link LOCMAF_AUDIO_GROUP_MAX_US} without video.
   */
  private async sendAudioGrouped(chunk: Uint8Array, meta: AudioChunkMeta): Promise<void> {
    const captureUs = this.toWallClockUs('audio', meta.timestampUs);
    const extensions = encodeLocHeaders({ captureTimestamp: captureUs }, this.locOptions());
    const live = this.deliverableOutlets('audio');
    if (live.length === 0) return;
    // A subscription without the open group (new, resumed, or failed) starts the next one.
    if (!this.audioGroupOpen || live.some(([, outlet]) => outlet.streamId === null)
        || this.audioStreamVideoGroup !== this.videoGroupId
        || captureUs - this.audioGroupStartUs >= LOCMAF_AUDIO_GROUP_MAX_US) {
      for (const outlet of this.outlets.audio.values()) this.closeOutletStream(outlet);
      this.audioGroupId++;
      this.audioObjectId = 0n;
      this.audioLocmafState = new LocmafGroupState();
      this.audioStreamVideoGroup = this.videoGroupId;
      this.audioGroupStartUs = captureUs;
      this.audioGroupOpen = true;
      await this.openOutletStreams('audio', live, this.audioGroupId, 64);
    }
    const ready = live.filter(([, outlet]) => outlet.streamId !== null);
    if (ready.length === 0) {
      this.audioGroupOpen = false;
      return;
    }
    const duration = meta.durationUs && meta.durationUs > 0 ? meta.durationUs : DEFAULT_AUDIO_FRAME_US;
    const cmafChunk = buildChunk({
      trackId: CMAF_AUDIO_TRACK_ID,
      sequence: ++this.cmafAudioSequence,
      baseDecodeTime: this.onDecodeTimeline('audio', captureUs, duration),
      duration,
      keyframe: true,
      data: chunk,
    });
    const payload = this.toLocmaf('audio', cmafChunk, this.audioLocmafState, this.audioObjectId);
    if (!await this.sendToOutlets('audio', ready, this.audioObjectId, payload, extensions)) {
      // The group's delta chain is broken: the next chunk opens a new group.
      this.audioGroupOpen = false;
      return;
    }
    this.noteAudioSent(chunk.byteLength, this.audioGroupId, this.audioObjectId);
    this.audioObjectId++;
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

  /** Draft 18 and later give LOC-01's 0x02/0x04 Track scope, so they carry LOC-04's ids;
   *  self-describing objects use LOC-04's ids on every draft. */
  private locOptions(): { wireProfile: ReturnType<typeof locWireProfileForDraft>; locVersion: 1 | 4 } {
    const locVersion = isRequestStreamDraft(this.draft) || this.selfDescribing || this.locTimescale ? 4 : 1;
    return { wireProfile: locWireProfileForDraft(this.draft), locVersion };
  }

  /** Capture time (with Timescale if asked), plus the codec string on a self-describing object. */
  private timing(captureUs: bigint, codec: string | undefined): LocHeaders {
    const codecString = this.selfDescribing && codec !== undefined
      ? { unknown: new Map([[LOC_PROP_CODECSTRING, new TextEncoder().encode(codec)]]) } : {};
    return this.locTimescale
      ? { timestamp: captureUs, timescale: MICROS_PER_SECOND, ...codecString }
      : { captureTimestamp: captureUs, ...codecString };
  }


  private videoExtensions(meta: VideoChunkMeta, captureUs: bigint): Uint8Array | undefined {
    // CMAF carries its own decode time and sync flags; only the capture time rides along.
    if (this.cmaf) {
      return encodeLocHeaders({ captureTimestamp: captureUs }, this.locOptions());
    }
    return encodeLocHeaders({
      ...this.timing(captureUs, this.selfDescribing?.videoCodec),
      videoFrameMarking: {
        independent: meta.isKeyframe,
        // No temporal layers, so every P-frame is a reference for the next.
        discardable: false,
        baseLayerSync: false,
        startOfFrame: true,
        endOfFrame: true,
        temporalId: 0,
      },
      // Parameter sets travel before key frames (LOC-04 §2.1.2); on a delta a
      // player that reconfigures on them would reset its decoder.
      ...(meta.isKeyframe && meta.videoConfig ? { videoConfig: meta.videoConfig } : {}),
    }, this.locOptions());
  }

  private async sendVideoChunk(data: Uint8Array, meta: VideoChunkMeta): Promise<void> {
    if (meta.isKeyframe) {
      // New group per keyframe. The previous subgroup has no further writers
      // (the pump is the only one), so its close needs no await — but it
      // IS tracked, so drain() waits for it. The slot is cleared BEFORE the
      // new open: a failed open must leave NO stream, not revive the old one.
      for (const outlet of this.outlets.video.values()) this.closeOutletStream(outlet);
      this.videoGroupId++;
      this.videoObjectId = 0n;
      this.videoLocmafState = new LocmafGroupState();
      this.videoGroupStartMs = this.wallClockUs() / 1000;
      // Any new group answers an outstanding request.
      this.newGroupPending = false;
      if (this.newGroupTimer !== null) clearTimeout(this.newGroupTimer);
      this.newGroupTimer = null;
      // endOfGroup: true — required for one-subgroup-per-GOP LOC video.
      // Without this, receivers cannot distinguish normal group completion
      // from an incomplete group and will wait for the intra-group timeout.
      await this.openOutletStreams('video', this.deliverableOutlets('video'), this.videoGroupId, 128);
    }
    // A subscription without the open subgroup (it joined, resumed, or failed
    // mid-group) takes no dependent frames until the next keyframe.
    const ready = this.deliverableOutlets('video').filter(([, outlet]) => outlet.streamId !== null);
    if (ready.length === 0) return;

    const captureUs = this.toWallClockUs('video', meta.timestampUs);
    const chunk = !this.cmaf ? data
      : meta.isKeyframe ? this.withCmafHeader('video', this.cmafVideoChunk(data, meta, captureUs), captureUs)
      : this.cmafVideoChunk(data, meta, captureUs);
    const payload = this.locmaf
      ? this.toLocmaf('video', chunk, this.videoLocmafState, this.videoObjectId)
      : chunk;
    // LOC: Object 0 of a subgroup must be the independent frame. A subscription
    // whose send fails loses the group, so its deltas drop until the next keyframe.
    if (!await this.sendToOutlets('video', ready, this.videoObjectId, payload, this.videoExtensions(meta, captureUs))) {
      return;
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
    const audioConfig = this.cmaf ? undefined : this.selfDescribing?.audioConfig;
    const extensions = encodeLocHeaders({
      ...(this.cmaf ? { captureTimestamp: captureUs } : this.timing(captureUs, this.selfDescribing?.audioCodec)),
      ...(audioConfig ? { audioConfig } : {}),
    }, this.locOptions());
    const data = this.cmaf
      ? this.withCmafHeader('audio', buildChunk({
        trackId: CMAF_AUDIO_TRACK_ID,
        sequence: ++this.cmafAudioSequence,
        baseDecodeTime: captureUs,
        duration: meta.durationUs && meta.durationUs > 0 ? meta.durationUs : DEFAULT_AUDIO_FRAME_US,
        keyframe: true,
        data: chunk,
      }), captureUs)
      : chunk;
    const payload = this.locmaf ? this.toLocmaf('audio', data, new LocmafGroupState(), 0n)
      : data;
    // Audio: one object per group (independently decodable, LOC §4.1);
    // audio gets higher priority (lower value) than video.
    const sendDatagram = this.audioDatagrams ? this.connection.sendDatagram?.bind(this.connection) : undefined;
    let sent = false;
    await Promise.all(this.deliverableOutlets('audio').map(async ([alias, outlet]) => {
      try {
        if (sendDatagram) {
          await sendDatagram(alias, groupId, 0n, payload, { publisherPriority: 64, ...(extensions ? { extensions } : {}) });
        } else {
          const streamId = await this.connection.openSubgroup(
            this.wrapInt(alias), this.wrapInt(groupId), this.wrapInt(0n), this.subgroupOptions(64));
          try {
            await this.connection.sendObject(streamId, this.wrapInt(0n), payload, extensions);
          } catch (err) {
            this.trackClose(streamId); // best-effort terminal cleanup for the failed stream
            throw err;
          }
          await this.trackClose(streamId);
        }
        sent = true;
        this.noteSent('audio', outlet);
      } catch (err) {
        this.outletFailed('audio', alias, outlet, err);
      }
    }));
    if (sent) this.noteAudioSent(chunk.byteLength, groupId);
  }

  /**
   * One CMAF chunk around an encoded video frame, decode time = capture time.
   * Without an encoder duration, a frame lasts the median recent capture
   * interval: one odd interval (a skipped frame, a burst) is not a frame's length.
   */
  /** Self-describing CMAF: the track's init segment before a group's first
   *  object, at most once a second, so players without a catalog can start. */
  private withCmafHeader(track: 'video' | 'audio', chunk: Uint8Array, captureUs: bigint): Uint8Array {
    if (!this.cmafHeaderInBand) return chunk;
    const init = this.cmafInit?.();
    const header = track === 'video' ? init?.videoInit : init?.audioInit;
    const last = this.cmafHeaderSentUs[track];
    if (!header || (last !== null && captureUs - last < CMAF_HEADER_REPEAT_US)) return chunk;
    this.cmafHeaderSentUs[track] = captureUs;
    const out = new Uint8Array(header.byteLength + chunk.byteLength);
    out.set(header, 0);
    out.set(chunk, header.byteLength);
    return out;
  }

  private cmafVideoChunk(data: Uint8Array, meta: VideoChunkMeta, captureUs: bigint): Uint8Array {
    const last = this.lastVideoCaptureUs;
    this.lastVideoCaptureUs = captureUs;
    const sinceLast = last === null ? 0 : Number(captureUs - last);
    if (sinceLast > 0 && sinceLast < 1_000_000) {
      this.videoIntervalsUs.push(sinceLast);
      if (this.videoIntervalsUs.length > 15) this.videoIntervalsUs.shift();
    }
    const sorted = [...this.videoIntervalsUs].sort((a, b) => a - b);
    const duration = meta.durationUs && meta.durationUs > 0 ? meta.durationUs
      : sorted.length > 0 ? sorted[sorted.length >> 1]! : DEFAULT_VIDEO_FRAME_US;
    const decodeUs = this.clampVideoDecode(
      this.locmaf ? this.onDecodeTimeline('video', captureUs, duration) : captureUs);
    if (this.locmaf) this.nextDecodeUs.video = decodeUs + BigInt(duration);
    this.lastVideoDecode = { decodeUs, durationUs: duration };
    return buildChunk({
      trackId: CMAF_VIDEO_TRACK_ID,
      sequence: ++this.cmafVideoSequence,
      baseDecodeTime: decodeUs,
      duration,
      keyframe: meta.isKeyframe,
      data,
    });
  }

  /** LOCMAF headers sent so far, full and delta. */
  get locmafHeaders(): { full: number; delta: number } {
    return { ...this.locmafHeaderCounts };
  }

  /** A CMAF chunk as a serialized LOCMAF Object, chained in its group. */
  private toLocmaf(track: 'video' | 'audio', chunk: Uint8Array, state: LocmafGroupState, objectId: bigint): Uint8Array {
    let context = this.locmafContexts.get(track);
    if (!context) {
      const init = this.cmafInit?.();
      const initBytes = track === 'video' ? init?.videoInit : init?.audioInit;
      if (!initBytes) throw new Error(`LOCMAF ${track}: no CMAF init segment to encode against`);
      context = parseLocmafTrackContext(initBytes);
      this.locmafContexts.set(track, context);
    }
    const object = this.locmafEncoder.encode(chunk, state, context, false, objectId);
    if (object.kind === 'moof') this.locmafHeaderCounts[object.header.full ? 'full' : 'delta']++;
    return serializeLocmafObject(object);
  }

  /** Accounting shared by the stream and datagram audio paths. Concurrent
   *  publications finish out of order, so the largest group is a max. */
  private noteAudioSent(bytes: number, groupId: bigint, objectId = 0n): void {
    const largest = this.audioLargest;
    if (largest === null || groupId > largest.group || (groupId === largest.group && objectId > largest.object)) {
      this.audioLargest = { group: groupId, object: objectId };
    }
    this.audioChunks++;
    this.audioBytes += bytes;
    this.onCounts?.(this.videoFrames, this.audioChunks);
    if (this.audioQueue.length < this.audioQueueMax) this.audioOverflowing = false;
  }
}
