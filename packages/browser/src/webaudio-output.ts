/**
 * WebAudioOutput — schedules decoded audio for playout via AudioContext.
 *
 * Implements AudioOutputLike for use with CommandDispatcher.
 * Uses AudioBufferSourceNode for sample-accurate scheduling.
 *
 * @see draft-ietf-moq-loc-01 §2.3.1.1 (CaptureTimestamp for sync)
 * @see draft-ietf-moq-loc-01 §2.3.3.1 (AudioLevel for silence optimization)
 * @module
 */

import type { AudioOutputLike } from '@moqt/player';
import type { ClockSource } from '@moqt/playback';

/** Live-edge bounds on the audio lead (seconds behind the capture-aligned schedule). */
export interface WebAudioOutputOptions {
  /** Lead beyond which queued audio is dropped and the chain re-anchored. Default 0.75. */
  readonly maxAheadSec?: number;
  /** Lead the soft chase drains toward and a hard snap lands at. Default 0.15. */
  readonly targetAheadSec?: number;
}

const LIVE_EDGE_MAX_AHEAD_SEC = 0.75;
const LIVE_EDGE_TARGET_AHEAD_SEC = 0.15;
/**
 * Rate while shedding lead above target. AudioBufferSourceNode rate also
 * shifts pitch: 1.02 is a third of a semitone, 1.05 is nearly a full one.
 */
const CHASE_RATE = 1.02;
/** Chase engages above target + this, releases at target (hysteresis). */
const CHASE_ON_SEC = 0.1;

/**
 * WebAudio playout behind AudioOutputLike.
 *
 * Schedules decoded AudioData as AudioBufferSourceNodes aligned with
 * the pipeline's render timeline (CaptureTimestamp-based A/V sync).
 * Maps renderTimeUs (performance.now domain) → AudioContext.currentTime
 * so audio playout is synchronized with video frame presentation.
 *
 * A healthy chain plays back-to-back regardless of render times, so a
 * late anchor or a burst leaves the chain behind its capture-aligned
 * schedule permanently. That lead is bounded: a soft rate chase drains it
 * toward `targetAheadSec`, and past `maxAheadSec` queued audio beyond the
 * landing point is dropped and the chain re-anchored there.
 *
 * @see draft-ietf-moq-loc-01 §2.3.1.1 (CaptureTimestamp for sync)
 */
export class WebAudioOutput implements AudioOutputLike {
  private readonly audioCtx: AudioContext;

  /**
   * Audio destination node. Sources connect here instead of directly
   * to audioCtx.destination. Defaults to audioCtx.destination but can
   * be overridden to insert a GainNode for volume control.
   */
  private readonly destination: AudioNode;

  /**
   * Next scheduled playout time in AudioContext.currentTime units.
   * Tracks the end of the last scheduled buffer for seamless playback.
   */
  private nextScheduledTime = 0;

  /** Active source nodes — tracked for flush/destroy. */
  private readonly activeSources: AudioBufferSourceNode[] = [];

  /**
   * Scheduled-buffer ring for playhead observability: which capture
   * timestamp is coming out of the speakers right now. One entry per
   * scheduled buffer; pruned lazily once playout passes a buffer's end.
   * `captureUs` is the chunk's CaptureTimestamp as passed to schedule().
   * AudioData.timestamp is only a fallback: decoders may rebase it.
   */
  private readonly scheduledRing: Array<{
    captureUs: number;
    startSec: number;
    durSec: number;
    rate: number;
    source: AudioBufferSourceNode;
  }> = [];

  /** Current playback rate for live catch-up. @see draft-ietf-moq-msf-00 §5.1.16 */
  private _playbackRate = 1.0;

  /** Buffers that arrived after the chain had already run dry (silent gap). */
  private _underrunCount = 0;
  private hasScheduled = false;

  private readonly maxAheadSec: number;
  private readonly targetAheadSec: number;
  private _chasing = false;
  private _liveEdgeSnapCount = 0;
  private _leadSec: number | null = null;

  /** Audio scheduled beyond the current playout point, in seconds. */
  get scheduledAheadSec(): number {
    return Math.max(0, this.nextScheduledTime - this.audioCtx.currentTime);
  }

  get underrunCount(): number {
    return this._underrunCount;
  }

  /** Last measured lead of the chain behind its capture-aligned schedule (s). */
  get captureLeadSec(): number | null {
    return this._leadSec;
  }

  /** Whether the soft chase is shedding lead. */
  get chasing(): boolean {
    return this._chasing;
  }

  /** Hard re-anchors that dropped queued audio. */
  get liveEdgeSnapCount(): number {
    return this._liveEdgeSnapCount;
  }

  /**
   * Local playback delay in seconds, applied at anchor/re-anchor time.
   *
   * Delay unification: integrated players pass 0 here — the shared playout
   * cushion (the same adaptive value the video render-time recompute uses)
   * arrives INSIDE `renderTimeUs`, applied upstream by the CommandDispatcher.
   * A non-zero value here is a second, independent delay policy that can
   * diverge from video's and re-assert that divergence on every underrun
   * re-anchor (A/V skew) — with the dispatcher composition it double-delays
   * audio. The default is therefore 0; pass a value only when using this
   * class standalone, without the dispatcher's cushion.
   */
  private readonly playbackDelaySec: number;

  /** Shared clock — when audio-backed, eliminates drift in toAudioCtxTime(). */
  private readonly clock: ClockSource;

  constructor(
    audioCtx: AudioContext,
    destination?: AudioNode,
    playbackDelayMs = 0,
    clock?: ClockSource,
    options: WebAudioOutputOptions = {},
  ) {
    this.audioCtx = audioCtx;
    this.destination = destination ?? audioCtx.destination;
    this.playbackDelaySec = playbackDelayMs / 1000;
    this.clock = clock ?? { now: () => performance.now() * 1000 };
    this.targetAheadSec = options.targetAheadSec ?? LIVE_EDGE_TARGET_AHEAD_SEC;
    this.maxAheadSec = Math.max(options.maxAheadSec ?? LIVE_EDGE_MAX_AHEAD_SEC, this.targetAheadSec);
  }

  /**
   * Convert renderTimeUs (pipeline clock domain) to AudioContext.currentTime seconds.
   *
   * Uses the shared clock for the delta computation. When the clock is audio-backed
   * (AudioAlignedClock), clock.now() and audioCtx.currentTime are on the same
   * oscillator — the delta has zero drift. When performance-backed, equivalent
   * to the original performance.now() conversion.
   */
  private toAudioCtxTime(renderTimeUs: number): number {
    const nowUs = this.clock.now();
    const deltaSec = (renderTimeUs - nowUs) / 1_000_000;
    return this.audioCtx.currentTime + deltaSec;
  }

  /**
   * Schedule an audio chunk for playout.
   *
   * Decodes AudioData to AudioBuffer, schedules via AudioBufferSourceNode.
   * Uses renderTimeUs to align with video, but ensures seamless back-to-back
   * when samples are contiguous.
   *
   * @param data AudioData from the decoder output callback
   * @param renderTimeUs Render time in microseconds (pipeline clock domain)
   *
   * @see draft-ietf-moq-loc-01 §2.3.1.1 (CaptureTimestamp for A/V sync)
   */
  schedule(data: unknown, renderTimeUs: number, captureTimestampUs?: number): void {
    const audioData = data as AudioData;

    // Copy decoded PCM into an AudioBuffer.
    // AudioData holds native memory — close() is required.
    const buf = this.audioCtx.createBuffer(
      audioData.numberOfChannels,
      audioData.numberOfFrames,
      audioData.sampleRate,
    );

    for (let ch = 0; ch < audioData.numberOfChannels; ch++) {
      const dest = buf.getChannelData(ch);
      audioData.copyTo(dest, { planeIndex: ch, format: 'f32-planar' });
    }
    // Capture timeline position of this buffer — read BEFORE close().
    const captureUs = captureTimestampUs ?? audioData.timestamp;
    audioData.close();

    const now = this.audioCtx.currentTime;
    // Where this buffer belongs on the capture-aligned timeline.
    const alignedTime = renderTimeUs > 0
      ? this.toAudioCtxTime(renderTimeUs) + this.playbackDelaySec : null;

    // Audio scheduling strategy:
    // - Normal playback: chain back-to-back (nextScheduledTime) for
    //   seamless, gap-free audio. Using targetTime per-sample causes
    //   drift when samples arrive in bursts from the jitter buffer.
    // - After stall/gap: snap to sync-aligned targetTime to re-sync
    //   with video (nextScheduledTime is in the past).
    // - playbackDelaySec matches the video output delay so both media
    //   types start at the same wall-clock offset.
    let startTime: number;
    if (this.nextScheduledTime >= now) {
      // Normal playback — back-to-back for seamless audio
      startTime = this.nextScheduledTime;
      if (alignedTime !== null) {
        // Lead = queued backlog + arrival lateness. Only the backlog can be
        // shed by dropping; lateness is left to the chase.
        const lead = startTime - alignedTime;
        this._leadSec = lead;
        const landing = alignedTime + this.targetAheadSec;
        // Only snap when the landing is still in the FUTURE. A large lead
        // with the landing already past means audio is behind its sync
        // reference, not ahead of it: dropping the queue there discards
        // the only media we have and stops the buffer mid-playback.
        // Rate chase is the only legitimate tool when behind.
        if (lead > this.maxAheadSec && landing > now && landing < startTime) {
          this.dropScheduledFrom(landing);
          this._liveEdgeSnapCount++;
          this._chasing = false;
          startTime = landing;
        } else if (lead > this.targetAheadSec + CHASE_ON_SEC) {
          this._chasing = true;
        } else if (lead <= this.targetAheadSec) {
          this._chasing = false;
        }
      }
    } else if (this.hasScheduled) {
      // Chain ran dry before this buffer arrived: an audible gap.
      this._underrunCount++;
      this._chasing = false;
      startTime = alignedTime !== null ? Math.max(alignedTime, now) : now + this.playbackDelaySec;
    } else if (alignedTime !== null) {
      // After stall — jump to sync-aligned position + playback delay
      startTime = Math.max(alignedTime, now);
    } else {
      // No render time (sync not established) — start from now + delay
      startTime = now + this.playbackDelaySec;
    }

    // Schedule for playout.
    const source = this.audioCtx.createBufferSource();
    source.buffer = buf;
    // Catch-up playback rate (>1.0 = faster playout). The live-edge chase
    // takes the larger of the two rather than multiplying them, which would
    // stack pitch shifts. @see draft-ietf-moq-msf-00 §5.1.16 (targetLatency)
    const rate = this._chasing ? Math.max(this._playbackRate, CHASE_RATE) : this._playbackRate;
    source.playbackRate.value = rate;
    source.connect(this.destination);
    source.start(startTime);
    this.hasScheduled = true;
    // Duration at adjusted rate — faster playout means shorter wall-clock time.
    const durSec = buf.duration / rate;
    this.nextScheduledTime = startTime + durSec;

    // Playhead observability: record what was scheduled where, so
    // playheadCaptureUs() can answer "what capture timestamp is being heard
    // right now." Also the drop set for a live-edge snap.
    this.scheduledRing.push({ captureUs, startSec: startTime, durSec, rate, source });

    // Track for flush/destroy cleanup
    this.activeSources.push(source);
    source.onended = () => {
      const idx = this.activeSources.indexOf(source);
      if (idx !== -1) this.activeSources.splice(idx, 1);
    };
  }

  /** Cancel audio scheduled at or after `t`, truncate the buffer spanning it, and re-anchor the chain there. */
  private dropScheduledFrom(t: number): void {
    const kept: typeof this.scheduledRing = [];
    for (const entry of this.scheduledRing) {
      if (entry.startSec >= t) {
        try {
          entry.source.stop();
          entry.source.disconnect();
        } catch {
          // Already ended
        }
        const idx = this.activeSources.indexOf(entry.source);
        if (idx !== -1) this.activeSources.splice(idx, 1);
        continue;
      }
      if (entry.startSec + entry.durSec > t) {
        try { entry.source.stop(t); } catch { /* already ended */ }
        entry.durSec = t - entry.startSec;
      }
      kept.push(entry);
    }
    this.scheduledRing.length = 0;
    this.scheduledRing.push(...kept);
    this.nextScheduledTime = t;
  }

  /**
   * Set playback rate for live catch-up.
   * Applied to each new AudioBufferSourceNode on schedule().
   * @see draft-ietf-moq-msf-00 §5.1.16 (targetLatency)
   */
  setPlaybackRate(rate: number): void {
    this._playbackRate = rate;
  }

  /**
   * The capture timestamp (µs) at the AUDIO GRAPH's playhead — i.e. the
   * position `AudioContext.currentTime` has reached in the scheduled-buffer
   * ring. NOT literal speaker output: hardware/output latency
   * (`AudioContext.outputLatency`, typically 10-40ms) is not applied here;
   * if measured skew shows a consistent offset, that is a later calibration
   * concern, not noise. Returns null when the graph is silent: nothing
   * scheduled, playout not yet started (first-anchor delay), or playout has
   * run past the last scheduled buffer (starvation).
   *
   * Observability only — the LOC A/V skew measurement compares this against
   * the video frame's CaptureTimestamp at render time. Exact across chained
   * buffers and playbackRate changes (rate recorded per buffer at schedule).
   */
  playheadCaptureUs(): number | null {
    const now = this.audioCtx.currentTime;
    // Lazy prune: drop buffers whose playout has fully passed.
    let firstLive = 0;
    while (firstLive < this.scheduledRing.length
        && this.scheduledRing[firstLive]!.startSec + this.scheduledRing[firstLive]!.durSec <= now) {
      firstLive++;
    }
    if (firstLive > 0) this.scheduledRing.splice(0, firstLive);

    const playing = this.scheduledRing[0];
    if (!playing || now < playing.startSec) return null; // silent: starved or not yet started
    const intoBufferSec = now - playing.startSec;
    return playing.captureUs + intoBufferSec * playing.rate * 1_000_000;
  }

  /** Cancel all scheduled audio. */
  flush(): void {
    for (const source of this.activeSources) {
      try {
        source.stop();
        source.disconnect();
      } catch {
        // Already stopped or disconnected
      }
    }
    this.activeSources.length = 0;
    this.scheduledRing.length = 0;
    this.nextScheduledTime = 0;
    this.hasScheduled = false;
    this._chasing = false;
    this._leadSec = null;
  }

  /**
   * Current playout position in microseconds.
   * @see draft-ietf-moq-loc-01 §2.3.1.1 (CaptureTimestamp for sync)
   */
  get currentPlayoutTimeUs(): number {
    return this.audioCtx.currentTime * 1_000_000;
  }

  /** Release resources. */
  destroy(): void {
    this.flush();
  }
}
