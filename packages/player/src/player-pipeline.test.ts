/**
 * Tests for player-pipeline.ts — pipeline creation + event/command handling.
 *
 * @see draft-ietf-moq-loc-01 §2.1 (video bitstream → VideoDecoderLike)
 * @see draft-ietf-moq-loc-01 §4.1 (audio → AudioDecoderLike)
 * @see draft-ietf-moq-transport-16 §10.2.1.1 (Object Status gaps)
 * @module
 */

import { describe, it, expect, vi } from 'vitest';
import { RENDER_CUSHION_MAX_US, RENDER_CUSHION_BURST_MAX_US, RENDER_CUSHION_FALL_US_PER_SEC, RENDER_CUSHION_RISE_US_PER_SEC } from './render-cushion.js';
import {
  computePlaybackDelayUs,
  createPipelines,
  handlePipelineCommand,
  handlePipelineEvent,
  handleRecoveryAction,
  type PipelineCallbacks,
  type TrackInfo,
} from './player-pipeline.js';
import type { MoqtPlayerConfig } from './config.js';
import { SMOOTH_CLEAN_WINDOW_US, SMOOTH_MARGIN_US } from './latency-policy.js';
import type { DecoderCommand, PlaybackEvent, RecoveryAction, ClockSource, DecoderFeedback } from '@openmoq/playback';
import type { CommandDispatcher } from './command-dispatcher.js';
import type { MediaSourceLike, VideoDecoderLike, VideoRendererLike } from './interfaces.js';
import type { LoggerLike } from './logger.js';
import type { QualityController } from './quality-controller.js';
import { varint } from '@openmoq/transport';

// ─── Helpers ─────────────────────────────────────────────────────────

const mockClock: ClockSource = { now: () => 0 };

const mockLog: LoggerLike = {
  debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
};

function minimalConfig(overrides: Partial<MoqtPlayerConfig> = {}): MoqtPlayerConfig {
  return {
    url: 'https://relay.example.com/moq',
    namespace: 'live/broadcast',
    createTransport: async () => ({}) as any,
    createConnection: () => ({}) as any,
    maxRequestId: 100,
    gapTimeoutMs: 500,
    driftThresholdMs: 30,
    maxBufferDepth: 60,
    lateFrameThresholdMs: 100,
    maxConsecutiveGaps: 5,
    maxDecodeErrors: 10,
    ...overrides,
  } as MoqtPlayerConfig;
}

function mockCallbacks(): PipelineCallbacks {
  return {
    onFirstFrame: vi.fn(),
    onStall: vi.fn(),
    onDecodeError: vi.fn(),
    onFrameRendered: vi.fn(),
    onFeedback: vi.fn(),
    onCommand: vi.fn(),
    onEvent: vi.fn(),
  };
}

// ─── createPipelines ─────────────────────────────────────────────────

describe('createPipelines', () => {
  it.each([
    { packaging: 'cmaf' as const, decoding: 'mse' as const, videoReference: true },
    { packaging: 'locmaf' as const, decoding: 'mse' as const, videoReference: true },
    { packaging: 'loc' as const, decoding: 'mse' as const, videoReference: false },
    { packaging: 'locmaf' as const, decoding: 'frame' as const, videoReference: false },
  ])('anchors LOC video without waiting for an absent audio pipeline: $packaging/$decoding', ({ packaging, decoding, videoReference }) => {
    const decoder: VideoDecoderLike = {
      configure: vi.fn(), decode: vi.fn(), flush: vi.fn(async () => {}),
      reset: vi.fn(), destroy: vi.fn(), queueDepth: 0, onFrame: null, onError: null,
    };
    const renderer: VideoRendererLike = {
      enqueue: vi.fn(), flush: vi.fn(), destroy: vi.fn(),
      onFirstFrame: null, onFrameRendered: null, onStall: null,
    };
    const result = createPipelines(minimalConfig({ locmafDecoding: decoding,
      createVideoDecoder: () => decoder, createRenderer: () => renderer,
    }), mockClock, {
      video: { codec: 'avc1.64001e', packaging: 'loc' },
      audio: { codec: packaging === 'loc' ? 'opus' : 'mp4a.40.2', packaging, samplerate: 48000 },
    }, mockCallbacks());
    const object = { kind: 'data' as const, trackAlias: varint(1), groupId: varint(0), subgroupId: varint(0),
      objectId: varint(0), publisherPriority: 128, extensions: undefined, payload: new Uint8Array([1]) };
    result.videoPipeline!.configure(new Uint8Array([1]));
    result.videoPipeline!.pushObject(object, { captureTimestamp: 12_345n,
      videoFrameMarking: { independent: true, startOfFrame: true, endOfFrame: true,
        discardable: false, baseLayerSync: false, temporalId: 0 } });
    result.videoPipeline!.tick();
    expect(result.syncController.hasReference).toBe(videoReference);
    const frame = { timestamp: 12_345, close: vi.fn() };
    decoder.onFrame!(frame, 0);
    expect(renderer.enqueue).toHaveBeenCalledTimes(videoReference ? 1 : 0);
    if (!videoReference) {
      result.audioPipeline!.configure(new Uint8Array([1]));
      result.audioPipeline!.pushObject(object, { captureTimestamp: 12_000n });
      result.audioPipeline!.tick();
      expect(result.syncController.hasReference).toBe(true);
      decoder.onFrame!({ timestamp: 12_346, close: vi.fn() }, 0);
      expect(renderer.enqueue).toHaveBeenCalledTimes(2);
    }
    expect(renderer.enqueue).toHaveBeenCalledWith(frame, expect.any(Number));
    result.commandDispatcher?.destroy();
  });
  it.each([0n, 9_007_199_254_740_993n])('preserves rendered timestamp %s through callbacks and feedback', (timestamp) => {
    const renderer: VideoRendererLike = {
      enqueue: vi.fn(), flush: vi.fn(), destroy: vi.fn(),
      onFirstFrame: null, onFrameRendered: null, onStall: null,
    };
    const callbacks = mockCallbacks();
    const onFrameRendered = vi.fn((captureTimestampUs: bigint, actualRenderUs: number) => {
      expect(captureTimestampUs + 1n).toBe(timestamp + 1n);
      expect(actualRenderUs).toBe(123_456);
    });
    callbacks.onFrameRendered = onFrameRendered;
    const result = createPipelines(minimalConfig({
      createRenderer: () => renderer,
      createVideoDecoder: () => ({ configure: vi.fn(), destroy: vi.fn() }) as any,
    }), mockClock, {
      video: { codec: 'avc1.64001e', packaging: 'loc' }, audio: undefined,
    }, callbacks);

    try {
      renderer.onFrameRendered!(timestamp, 123_456, 120_000);
      expect(onFrameRendered).toHaveBeenCalledExactlyOnceWith(timestamp, 123_456);
      expect(callbacks.onFeedback).toHaveBeenCalledExactlyOnceWith({
        type: 'frame_rendered', mediaType: 'video', captureTimestampUs: timestamp,
        actualRenderUs: 123_456, scheduledRenderUs: 120_000,
      });
    } finally {
      result.commandDispatcher?.destroy();
    }
  });

  it('creates video pipeline for LOC track', () => {
    const trackInfo: TrackInfo = {
      video: { codec: 'avc1.64001e', width: 1920, height: 1080, packaging: 'loc' },
      audio: undefined,
    };
    const result = createPipelines(minimalConfig(), mockClock, trackInfo, mockCallbacks());
    expect(result.videoPipeline).not.toBeNull();
    expect(result.audioPipeline).toBeNull();
  });

  it('creates audio pipeline for LOC track', () => {
    const trackInfo: TrackInfo = {
      video: undefined,
      audio: { codec: 'opus', samplerate: 48000, packaging: 'loc' },
    };
    const result = createPipelines(minimalConfig(), mockClock, trackInfo, mockCallbacks());
    expect(result.audioPipeline).not.toBeNull();
    expect(result.videoPipeline).toBeNull();
  });

  it('creates SyncController', () => {
    const trackInfo: TrackInfo = {
      video: { codec: 'avc1.64001e', packaging: 'loc' },
      audio: undefined,
    };
    const result = createPipelines(minimalConfig(), mockClock, trackInfo, mockCallbacks());
    expect(result.syncController).not.toBeNull();
  });

  it('gives the default recovery controller the clock, so sustained stalls reduce quality', () => {
    let nowUs = 0;
    const clock: ClockSource = { now: () => nowUs };
    const trackInfo: TrackInfo = {
      video: { codec: 'avc1.64001e', packaging: 'loc' },
      audio: undefined,
    };
    const { recoveryController } = createPipelines(minimalConfig(), clock, trackInfo, mockCallbacks());

    // Five sustained stalls a second apart: inside the 30s window. Without a
    // clock the windowed counter never runs and every stall only skips forward.
    const actions: RecoveryAction['type'][] = [];
    for (let i = 0; i < 5; i++) {
      nowUs += 1_000_000;
      actions.push(recoveryController.evaluate({ type: 'stall', durationMs: 500 }).type);
    }
    expect(actions).toEqual(['skip_forward', 'skip_forward', 'skip_forward', 'skip_forward', 'reduce_quality']);
  });

  it('creates CommandDispatcher when video decoder factory provided', () => {
    const config = minimalConfig({
      createVideoDecoder: () => ({
        configure: vi.fn(),
        decode: vi.fn(),
        flush: vi.fn(),
        close: vi.fn(),
        reset: vi.fn(),
        state: 'unconfigured',
        decodeQueueSize: 0,
        ondequeue: null,
      }) as any,
    });
    const trackInfo: TrackInfo = {
      video: { codec: 'avc1.64001e', packaging: 'loc' },
      audio: undefined,
    };
    const result = createPipelines(config, mockClock, trackInfo, mockCallbacks());
    expect(result.commandDispatcher).not.toBeNull();
  });

  it('skips video pipeline for CMAF tracks — MSE handles it', () => {
    const config = minimalConfig({
      createMediaSource: () => ({
        initialize: vi.fn(),
        appendChunk: vi.fn(),
        destroy: vi.fn(),
        onFirstFrame: null,
        onStall: null,
        onError: null,
      }) as any,
    });
    const trackInfo: TrackInfo = {
      video: { codec: 'avc1.64001e', packaging: 'cmaf', initData: btoa('ftyp') },
      audio: undefined,
    };
    const result = createPipelines(config, mockClock, trackInfo, mockCallbacks());
    expect(result.videoPipeline).toBeNull();
    expect(result.mediaSource).not.toBeNull();
  });

  it('locmaf tracks go through MSE like CMAF — no WebCodecs decoder/renderer, no LOC pipeline (LOCMAF §6)', () => {
    const createVideoDecoder = vi.fn();
    const createRenderer = vi.fn();
    const config = minimalConfig({
      createMediaSource: () => ({
        initialize: vi.fn(), appendChunk: vi.fn(), destroy: vi.fn(),
        onFirstFrame: null, onStall: null, onError: null,
      }) as any,
      createVideoDecoder,
      createRenderer,
    });
    const trackInfo: TrackInfo = {
      video: { codec: 'avc1.640028', packaging: 'locmaf', initData: btoa('ftyp') },
      audio: undefined,
    };
    const result = createPipelines(config, mockClock, trackInfo, mockCallbacks());
    expect(result.mediaSource).not.toBeNull();
    expect(result.videoPipeline).toBeNull();
    expect(createVideoDecoder).not.toHaveBeenCalled();
    expect(createRenderer).not.toHaveBeenCalled();
    expect(result.getRenderCushionUs).toBeUndefined();
  });

  it('returns null CommandDispatcher when no decoder factories', () => {
    const trackInfo: TrackInfo = {
      video: { codec: 'avc1.64001e', packaging: 'loc' },
      audio: undefined,
    };
    const result = createPipelines(minimalConfig(), mockClock, trackInfo, mockCallbacks());
    expect(result.commandDispatcher).toBeNull();
  });

  it('holds video frames until sync reference is established (sync gating)', () => {
    let nowUs = 0;
    const clock: ClockSource = { now: () => nowUs };

    const videoDecoder = {
      configure: vi.fn(),
      decode: vi.fn(),
      flush: vi.fn(),
      close: vi.fn(),
      reset: vi.fn(),
      state: 'configured',
      decodeQueueSize: 0,
      ondequeue: null,
      onFrame: null as ((frame: unknown, renderTimeUs: number) => void) | null,
      onError: null as ((error: Error) => void) | null,
    };
    const renderer = {
      enqueue: vi.fn(),
      flush: vi.fn(),
      destroy: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
      onFirstFrame: null as (() => void) | null,
      onFrameRendered: null as ((captureTimestampUs: bigint, actualRenderUs: number) => void) | null,
      onStall: null as ((durationMs: number) => void) | null,
    };

    const config = minimalConfig({
      createVideoDecoder: () => videoDecoder as any,
      createRenderer: () => renderer as any,
    });
    const trackInfo: TrackInfo = {
      video: { codec: 'avc1.64001e', packaging: 'loc' },
      audio: undefined, // video-only
    };

    const result = createPipelines(config, clock, trackInfo, mockCallbacks());

    nowUs = 100_000;
    // Before sync reference: frame should be HELD, not enqueued
    videoDecoder.onFrame?.({ timestamp: 1_000_000, close: vi.fn() } as any, 0);
    expect(renderer.enqueue).not.toHaveBeenCalled();

    // Simulate audio setting the reference (or video-only pipeline doing it)
    result.syncController.setAudioReference(900_000n);

    // Next frame: should drain held frame + enqueue current
    nowUs = 200_000;
    videoDecoder.onFrame?.({ timestamp: 1_033_333, close: vi.fn() } as any, 0);
    // Both held + current should be enqueued
    expect(renderer.enqueue).toHaveBeenCalledTimes(2);
  });

  it('smooth latency: a late frame raises the shared cushion and renders at its new slot; low-latency live renders it now', () => {
    const run = (latencyMode: 'live' | 'smooth') => {
      let nowUs = 0;
      const clock: ClockSource = { now: () => nowUs };
      const videoDecoder = {
        configure: vi.fn(), decode: vi.fn(), flush: vi.fn(), close: vi.fn(), reset: vi.fn(),
        state: 'configured', decodeQueueSize: 0, ondequeue: null,
        onFrame: null as ((frame: unknown, renderTimeUs: number) => void) | null,
        onError: null as ((error: Error) => void) | null,
      };
      const renderer = {
        enqueue: vi.fn(), flush: vi.fn(), destroy: vi.fn(), start: vi.fn(), stop: vi.fn(),
        onFirstFrame: null, onFrameRendered: null, onStall: null,
      };
      const config = minimalConfig({
        createVideoDecoder: () => videoDecoder as any,
        createRenderer: () => renderer as any,
        latencyMode,
        smoothFloorMs: 0,
        ...(latencyMode === 'live' ? { congestionControl: 'low-latency' as const } : {}),
      });
      const trackInfo: TrackInfo = { video: { codec: 'avc1.64001e', packaging: 'loc' }, audio: undefined };
      const result = createPipelines(config, clock, trackInfo, mockCallbacks());
      nowUs = 100_000;
      result.syncController.setAudioReference(1_000_000n);   // capture 1.0 s renders at 0.1 s
      nowUs = 200_000;
      videoDecoder.onFrame?.({ timestamp: 1_100_000, close: vi.fn() } as any, 0);  // slot 0.2 + 0.2 cushion
      // Past the startup grace: capture 4.2 s renders at 3.3 s, slot 3.5 s, decoded at 3.9 s.
      nowUs = 3_900_000;
      videoDecoder.onFrame?.({ timestamp: 4_200_000, close: vi.fn() } as any, 0);  // 400 ms late
      return { times: renderer.enqueue.mock.calls.map((c) => c[1]), policy: result.latencyPolicy };
    };
    const live = run('live');
    expect(live.times).toEqual([400_000, 3_900_000]);
    expect(live.policy).toBeUndefined();
    const smooth = run('smooth');
    // 200 ms cushion + 400 ms late + 50 ms margin.
    expect(smooth.times).toEqual([400_000, 3_300_000 + 650_000]);
    expect(smooth.policy?.raises).toBe(1);
  });

  it('smooth latency: frames held for the sync reference do not raise the cushion', () => {
    let nowUs = 0;
    const clock: ClockSource = { now: () => nowUs };
    const videoDecoder = {
      configure: vi.fn(), decode: vi.fn(), flush: vi.fn(), close: vi.fn(), reset: vi.fn(),
      state: 'configured', decodeQueueSize: 0, ondequeue: null,
      onFrame: null as ((frame: unknown, renderTimeUs: number) => void) | null,
      onError: null as ((error: Error) => void) | null,
    };
    const renderer = {
      enqueue: vi.fn(), flush: vi.fn(), destroy: vi.fn(), start: vi.fn(), stop: vi.fn(),
      onFirstFrame: null, onFrameRendered: null, onStall: null,
    };
    const result = createPipelines(minimalConfig({
      createVideoDecoder: () => videoDecoder as any,
      createRenderer: () => renderer as any,
      latencyMode: 'smooth',
    }), clock, { video: { codec: 'avc1.64001e', packaging: 'loc' }, audio: undefined }, mockCallbacks());
    // Decoded before any reference: held. Its capture time is 1 s behind the reference set later.
    nowUs = 100_000;
    videoDecoder.onFrame?.({ timestamp: 1_000_000, close: vi.fn() } as any, 0);
    nowUs = 1_200_000;
    result.syncController.setAudioReference(2_000_000n);
    videoDecoder.onFrame?.({ timestamp: 2_000_000, close: vi.fn() } as any, 0);   // drains the held frame
    expect(renderer.enqueue).toHaveBeenCalledTimes(2);
    expect(result.latencyPolicy?.raises).toBe(0);
  });

  it('smooth latency: the cushion starts at the floor, so the first frame and audio play 1 s behind', () => {
    let nowUs = 0;
    const clock: ClockSource = { now: () => nowUs };
    const videoDecoder = {
      configure: vi.fn(), decode: vi.fn(), flush: vi.fn(), close: vi.fn(), reset: vi.fn(),
      state: 'configured', decodeQueueSize: 0, ondequeue: null,
      onFrame: null as ((frame: unknown, renderTimeUs: number) => void) | null,
      onError: null as ((error: Error) => void) | null,
    };
    const renderer = {
      enqueue: vi.fn(), flush: vi.fn(), destroy: vi.fn(), start: vi.fn(), stop: vi.fn(),
      onFirstFrame: null, onFrameRendered: null, onStall: null,
    };
    const result = createPipelines(minimalConfig({
      createVideoDecoder: () => videoDecoder as any,
      createRenderer: () => renderer as any,
      latencyMode: 'smooth',
    }), clock, { video: { codec: 'avc1.64001e', packaging: 'loc' }, audio: undefined }, mockCallbacks());
    expect(result.getRenderCushionUs?.()).toBe(1_000_000);
    nowUs = 100_000;
    result.syncController.setAudioReference(1_000_000n);   // capture 1.0 s renders at 0.1 s
    nowUs = 200_000;
    videoDecoder.onFrame?.({ timestamp: 1_100_000, close: vi.fn() } as any, 0);  // slot 0.2 + 1 s
    expect(renderer.enqueue.mock.calls.map((c) => c[1])).toEqual([1_200_000]);
    expect(result.latencyPolicy?.stats).toMatchObject({ heldMs: 1000, floorMs: 1000, raises: 0 });
  });
});

// ─── handlePipelineCommand ───────────────────────────────────────────

describe('handlePipelineCommand', () => {
  it('dispatches command to CommandDispatcher', () => {
    const dispatcher = { dispatch: vi.fn() } as unknown as CommandDispatcher;
    const emitEvent = vi.fn();
    const cmd: DecoderCommand = { type: 'decode_video', data: new Uint8Array(10), timestamp: 0, duration: 33333, isKey: true };
    handlePipelineCommand(cmd, undefined, dispatcher, null, emitEvent);
    expect(dispatcher.dispatch).toHaveBeenCalledWith(cmd);
  });

  it('applies commandTransform before dispatch', () => {
    const dispatcher = { dispatch: vi.fn() } as unknown as CommandDispatcher;
    const emitEvent = vi.fn();
    const cmd: DecoderCommand = { type: 'decode_video', data: new Uint8Array(10), timestamp: 0, duration: 33333, isKey: true };
    const transform = vi.fn((c: DecoderCommand) => ({ ...c, timestamp: 999 }));
    handlePipelineCommand(cmd, transform, dispatcher, null, emitEvent);
    expect(transform).toHaveBeenCalledWith(cmd);
    expect(dispatcher.dispatch).toHaveBeenCalledWith(expect.objectContaining({ timestamp: 999 }));
  });

  it('suppresses command when transform returns null', () => {
    const dispatcher = { dispatch: vi.fn() } as unknown as CommandDispatcher;
    const emitEvent = vi.fn();
    const cmd: DecoderCommand = { type: 'decode_video', data: new Uint8Array(10), timestamp: 0, duration: 33333, isKey: true };
    handlePipelineCommand(cmd, () => null, dispatcher, null, emitEvent);
    expect(dispatcher.dispatch).not.toHaveBeenCalled();
    expect(emitEvent).not.toHaveBeenCalled();
  });

  it('emits decoder_command event', () => {
    const emitEvent = vi.fn();
    const cmd: DecoderCommand = { type: 'decode_video', data: new Uint8Array(10), timestamp: 0, duration: 33333, isKey: true };
    handlePipelineCommand(cmd, undefined, null, null, emitEvent);
    expect(emitEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: 'decoder_command',
      command: cmd,
    }));
  });
});

// ─── handlePipelineEvent ─────────────────────────────────────────────

describe('handlePipelineEvent', () => {
  it('emits gap_detected', () => {
    const emitEvent = vi.fn();
    const evt: PlaybackEvent = { type: 'gap_detected', groupId: 5n };
    handlePipelineEvent('video', evt, {
      emitEvent, log: mockLog, syncController: null,
      syncResetThisTick: false, setSyncResetThisTick: vi.fn(),
      recoveryHook: (a: RecoveryAction) => a,
    });
    expect(emitEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: 'gap_detected', mediaType: 'video', groupId: 5n,
    }));
  });

  it('emits skip_forward and resets sync', () => {
    const emitEvent = vi.fn();
    const syncController = { reset: vi.fn() };
    const setSyncReset = vi.fn();
    const evt: PlaybackEvent = { type: 'skip_forward', fromGroupId: 3n, toGroupId: 7n };
    handlePipelineEvent('video', evt, {
      emitEvent, log: mockLog, syncController: syncController as any,
      syncResetThisTick: false, setSyncResetThisTick: setSyncReset,
      recoveryHook: (a: RecoveryAction) => a,
    });
    expect(syncController.reset).toHaveBeenCalled();
    expect(setSyncReset).toHaveBeenCalledWith(true);
    expect(emitEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: 'skip_forward', mediaType: 'video',
    }));
  });

  it('an audio skip_forward keeps the sync reference', () => {
    const syncController = { reset: vi.fn() };
    const setSyncReset = vi.fn();
    const recordDiagnostic = vi.fn();
    handlePipelineEvent('audio', { type: 'skip_forward', fromGroupId: 40n, toGroupId: 42n }, {
      emitEvent: vi.fn(), log: mockLog, syncController: syncController as any,
      syncResetThisTick: false, setSyncResetThisTick: setSyncReset, recordDiagnostic,
      recoveryHook: (a: RecoveryAction) => a,
    });
    expect(syncController.reset).not.toHaveBeenCalled();
    expect(setSyncReset).not.toHaveBeenCalled();
    expect(recordDiagnostic).toHaveBeenCalledWith('skip_forward');
    expect(recordDiagnostic).not.toHaveBeenCalledWith('sync_reset');
  });

  it('does not double-reset sync within same tick', () => {
    const emitEvent = vi.fn();
    const syncController = { reset: vi.fn() };
    const evt: PlaybackEvent = { type: 'skip_forward', fromGroupId: 3n, toGroupId: 7n };
    handlePipelineEvent('video', evt, {
      emitEvent, log: mockLog, syncController: syncController as any,
      syncResetThisTick: true, // already reset
      setSyncResetThisTick: vi.fn(),
      recoveryHook: (a: RecoveryAction) => a,
    });
    expect(syncController.reset).not.toHaveBeenCalled();
  });

  it('emits partial_group_abandoned with mediaType', () => {
    const emitEvent = vi.fn();
    const evt: PlaybackEvent = {
      type: 'partial_group_abandoned',
      fromGroupId: 5n,
      toGroupId: 6n,
      reason: 'intra-group timeout',
    };
    handlePipelineEvent('video', evt, {
      emitEvent, log: mockLog, syncController: null,
      syncResetThisTick: false, setSyncResetThisTick: vi.fn(),
      recoveryHook: (a: RecoveryAction) => a,
    });
    expect(emitEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: 'partial_group_abandoned',
      mediaType: 'video',
      fromGroupId: 5n,
      toGroupId: 6n,
      reason: 'intra-group timeout',
    }));
  });

  it('a timeline jump resets sync for either media type and emits the player event', () => {
    const emitEvent = vi.fn();
    const syncController = { reset: vi.fn() };
    const setSyncReset = vi.fn();
    handlePipelineEvent('audio', { type: 'timeline_jump', fromGroupId: 100n, toGroupId: 3600n, jumpUs: 70_000_000 }, {
      emitEvent, log: mockLog, syncController: syncController as any,
      syncResetThisTick: false, setSyncResetThisTick: setSyncReset,
      recoveryHook: (a: RecoveryAction) => a,
    });
    expect(syncController.reset).toHaveBeenCalledTimes(1);
    expect(setSyncReset).toHaveBeenCalledWith(true);
    expect(emitEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: 'timeline_jump', mediaType: 'audio', fromGroupId: 100n, toGroupId: 3600n, jumpMs: 70_000,
    }));
  });

  it('passes a local skip through to the recovery hook', () => {
    const recoveryHook = vi.fn((a: RecoveryAction) => a);
    handlePipelineEvent('video', { type: 'recovery', action: { type: 'skip_forward' }, localSkip: true }, {
      emitEvent: vi.fn(), log: mockLog, syncController: null,
      syncResetThisTick: false, setSyncResetThisTick: vi.fn(), recoveryHook,
    });
    expect(recoveryHook).toHaveBeenCalledWith({ type: 'skip_forward' }, true);
  });

  it('emits track_ended', () => {
    const emitEvent = vi.fn();
    const evt: PlaybackEvent = { type: 'track_ended' };
    handlePipelineEvent('audio', evt, {
      emitEvent, log: mockLog, syncController: null,
      syncResetThisTick: false, setSyncResetThisTick: vi.fn(),
      recoveryHook: (a: RecoveryAction) => a,
    });
    expect(emitEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: 'track_ended', mediaType: 'audio',
    }));
  });
});

// ─── handleRecoveryAction ────────────────────────────────────────────

describe('handleRecoveryAction', () => {
  it('peeks lower quality via QualityController (non-mutating)', () => {
    const qc = { peekLowerVideoQuality: vi.fn(() => ({ name: 'low', codec: 'avc1', bitrate: 500_000 })) };
    const callbacks = { onQualityReduced: vi.fn(), onResubscribe: vi.fn(), onTerminate: vi.fn() };
    const action: RecoveryAction = { type: 'reduce_quality' };
    handleRecoveryAction(action, 'video', qc as unknown as QualityController, mockLog, callbacks);
    expect(qc.peekLowerVideoQuality).toHaveBeenCalled();
    expect(callbacks.onQualityReduced).toHaveBeenCalled();
  });

  it('calls onResubscribe for recovery resubscribe action', () => {
    const callbacks = { onQualityReduced: vi.fn(), onResubscribe: vi.fn(), onTerminate: vi.fn() };
    const action: RecoveryAction = { type: 'resubscribe' };
    handleRecoveryAction(action, 'video', null, mockLog, callbacks);
    expect(callbacks.onResubscribe).toHaveBeenCalledWith('video', undefined);
  });

  it('a video skip_forward re-requests the next group', () => {
    const callbacks = { onQualityReduced: vi.fn(), onResubscribe: vi.fn(), onTerminate: vi.fn() };
    handleRecoveryAction({ type: 'skip_forward' }, 'video', null, mockLog, callbacks);
    expect(callbacks.onResubscribe).toHaveBeenCalledWith('video');
  });

  it('a local video skip_forward requests nothing', () => {
    const callbacks = { onQualityReduced: vi.fn(), onResubscribe: vi.fn(), onTerminate: vi.fn() };
    handleRecoveryAction({ type: 'skip_forward' }, 'video', null, mockLog, callbacks, true);
    expect(callbacks.onResubscribe).not.toHaveBeenCalled();
  });

  it('calls onTerminate for fatal recovery', () => {
    const callbacks = { onQualityReduced: vi.fn(), onResubscribe: vi.fn(), onTerminate: vi.fn() };
    const action: RecoveryAction = { type: 'terminate', reason: 'too many errors' };
    handleRecoveryAction(action, 'video', null, mockLog, callbacks);
    expect(callbacks.onTerminate).toHaveBeenCalledWith('too many errors');
  });
});

describe('handlePipelineEvent — LOC diagnostics counting (observability only)', () => {
  const baseCtx = () => ({
    emitEvent: vi.fn(), log: mockLog, syncController: null,
    syncResetThisTick: false, setSyncResetThisTick: vi.fn(),
    recoveryHook: (a: RecoveryAction) => a,
    recordDiagnostic: vi.fn(),
  });

  it.each([
    ['gap_detected', { type: 'gap_detected', groupId: 5n }],
    ['keyframe_waiting', { type: 'keyframe_waiting', groupId: 5n }],
    ['partial_group_abandoned', { type: 'partial_group_abandoned', fromGroupId: 1n, toGroupId: 2n, reason: 'x' }],
    ['backlog_shed', { type: 'backlog_shed', droppedGroups: 2, remainingGroups: 3, reason: 'x' }],
  ] as const)('records %s', (kind, evt) => {
    const ctx = baseCtx();
    handlePipelineEvent('video', evt as PlaybackEvent, ctx);
    expect(ctx.recordDiagnostic).toHaveBeenCalledWith(kind);
  });

  it('records skip_forward AND sync_reset when the reset actually runs', () => {
    const ctx = { ...baseCtx(), syncController: { reset: vi.fn() } as any };
    handlePipelineEvent('video', { type: 'skip_forward', fromGroupId: 1n, toGroupId: 2n } as PlaybackEvent, ctx);
    expect(ctx.recordDiagnostic).toHaveBeenCalledWith('skip_forward');
    expect(ctx.recordDiagnostic).toHaveBeenCalledWith('sync_reset');
  });

  it('does NOT record sync_reset when the same-tick guard suppresses the reset', () => {
    const ctx = { ...baseCtx(), syncController: { reset: vi.fn() } as any, syncResetThisTick: true };
    handlePipelineEvent('video', { type: 'skip_forward', fromGroupId: 1n, toGroupId: 2n } as PlaybackEvent, ctx);
    expect(ctx.recordDiagnostic).toHaveBeenCalledWith('skip_forward');
    expect(ctx.recordDiagnostic).not.toHaveBeenCalledWith('sync_reset');
  });

  it('records recovery_action only when the hook passes the action through', () => {
    const ctx = { ...baseCtx(), recoveryHook: () => null };
    handlePipelineEvent('video', { type: 'recovery', action: { type: 'skip_forward' } } as unknown as PlaybackEvent, ctx);
    expect(ctx.recordDiagnostic).not.toHaveBeenCalledWith('recovery_action');

    const ctx2 = baseCtx();
    handlePipelineEvent('video', { type: 'recovery', action: { type: 'reduce_quality' } } as unknown as PlaybackEvent, ctx2);
    expect(ctx2.recordDiagnostic).toHaveBeenCalledWith('recovery_action');
  });

  it('is optional: absent recordDiagnostic changes nothing', () => {
    const { recordDiagnostic: _omit, ...ctx } = baseCtx();
    expect(() => handlePipelineEvent('video',
      { type: 'skip_forward', fromGroupId: 1n, toGroupId: 2n } as PlaybackEvent,
      { ...ctx, syncController: { reset: vi.fn() } as any })).not.toThrow();
  });
});

describe('computePlaybackDelayUs — the ONE shared playout cushion', () => {
  it('normal RTT: max(adaptive, 200ms) for BOTH media types', () => {
    expect(computePlaybackDelayUs(120_000, undefined)).toBe(200_000);
    expect(computePlaybackDelayUs(120_000, 40)).toBe(200_000);
  });

  it('RTT < 5ms: static floor drops to 50ms', () => {
    expect(computePlaybackDelayUs(0, 2)).toBe(50_000);
    expect(computePlaybackDelayUs(30_000, 2)).toBe(50_000);
  });

  it('adaptive gap timeout above the floor wins (propagates to both media)', () => {
    expect(computePlaybackDelayUs(400_000, 40)).toBe(400_000);
    expect(computePlaybackDelayUs(400_000, 2)).toBe(400_000);
  });

  it('no adaptive signal: pure static floor', () => {
    expect(computePlaybackDelayUs(undefined, undefined)).toBe(200_000);
    expect(computePlaybackDelayUs(undefined, 2)).toBe(50_000);
  });

  // The static floor is a guess about jitter; a declared target is what the
  // publisher asked for. The guess must not silently overrule it.
  it('a declared target caps the floor, including the adaptive component', () => {
    expect(computePlaybackDelayUs(undefined, 40, 50_000)).toBe(50_000);
    expect(computePlaybackDelayUs(400_000, 40, 50_000)).toBe(50_000);
    expect(computePlaybackDelayUs(120_000, undefined, 30_000)).toBe(30_000);
  });

  it('a target above the floor does not raise it', () => {
    expect(computePlaybackDelayUs(undefined, 40, 900_000)).toBe(200_000);
    expect(computePlaybackDelayUs(undefined, 2, 900_000)).toBe(50_000);
  });

  it('a zero or absent target leaves the floor alone', () => {
    expect(computePlaybackDelayUs(undefined, 40, 0)).toBe(200_000);
    expect(computePlaybackDelayUs(undefined, 40)).toBe(200_000);
  });
});

describe('createPipelines — smoothed render cushion wiring (slice A)', () => {
  const LOC_AV: TrackInfo = {
    video: { codec: 'avc1.64001e', width: 1920, height: 1080, packaging: 'loc' },
    audio: { codec: 'opus', samplerate: 48000, packaging: 'loc' },
  };

  it('exposes getRenderCushionUs for LOC sessions (the smoothed value, floor at rest)', () => {
    const result = createPipelines(minimalConfig(), mockClock, LOC_AV, mockCallbacks());
    expect(result.getRenderCushionUs).toBeDefined();
    // Fresh session, no jitter: cushion sits at the 200ms static floor.
    expect(result.getRenderCushionUs!()).toBe(200_000);
  });

  it('getRenderCushionUs is a PURE PEEK: polling never advances the smoother (observability contract)', () => {
    const result = createPipelines(minimalConfig(), mockClock, LOC_AV, mockCallbacks());
    // Force the raw adaptive fuse high (simulates the 2000ms estimator spike).
    Object.defineProperty(result.videoPipeline, 'effectiveGapTimeoutUs', {
      get: () => 2_000_000, configurable: true,
    });
    // The smoother only moves when SCHEDULING calls update(); the getter must
    // not adopt the spike no matter how often telemetry polls it.
    expect(result.getRenderCushionUs!()).toBe(200_000);
    expect(result.getRenderCushionUs!()).toBe(200_000);
    expect(result.getRenderCushionUs!()).toBe(200_000);
    // (Clamp/slew behavior toward the cap is pinned in render-cushion.test.ts;
    // RENDER_CUSHION_MAX_US bounds any scheduled adoption of this spike.)
    expect(RENDER_CUSHION_MAX_US).toBeLessThan(2_000_000);
  });

  it('SEPARATION PIN: gap detector sees the raw 2000ms while the render cushion stays below it', () => {
    const result = createPipelines(minimalConfig(), mockClock, LOC_AV, mockCallbacks());
    Object.defineProperty(result.videoPipeline, 'effectiveGapTimeoutUs', {
      get: () => 2_000_000, configurable: true,
    });
    // The smoothed render cushion never mirrors the fuse: at rest it reads
    // the floor; even fully adopted it is clamped at RENDER_CUSHION_MAX_US…
    const cushionUs = result.getRenderCushionUs!();
    expect(cushionUs).toBeLessThanOrEqual(RENDER_CUSHION_MAX_US);
    expect(cushionUs).toBeLessThan(2_000_000);
    // …while the pipeline's OWN effective gap timeout — the value the gap
    // detector consumes — remains the raw adaptive 2000ms, untouched by
    // the smoother.
    expect(result.videoPipeline!.effectiveGapTimeoutUs).toBe(2_000_000);
  });

  it('renderCushionFloorMs overrides the RTT-derived floor', () => {
    const low = createPipelines(minimalConfig({ renderCushionFloorMs: 50 }), mockClock, LOC_AV, mockCallbacks(), 40);
    expect(low.getRenderCushionUs!()).toBe(50_000);
    const high = createPipelines(minimalConfig({ renderCushionFloorMs: 900 }), mockClock, LOC_AV, mockCallbacks(), 2);
    expect(high.getRenderCushionUs!()).toBe(900_000);
  });

  it('renderCushionMaxMs caps scheduled adoption; a floor above the default cap lifts it', () => {
    const withDecoder = (overrides: Partial<MoqtPlayerConfig>) => minimalConfig({
      ...overrides,
      createVideoDecoder: () => ({
        configure: vi.fn(), decode: vi.fn(), flush: vi.fn(), close: vi.fn(), reset: vi.fn(),
        state: 'unconfigured', decodeQueueSize: 0, ondequeue: null,
      }) as any,
    });
    // The scheduling path advances the smoother; its first update snaps to
    // the clamped target.
    const schedule = (r: ReturnType<typeof createPipelines>) => {
      Object.defineProperty(r.videoPipeline, 'effectiveGapTimeoutUs', {
        get: () => 2_000_000, configurable: true,
      });
      (r.commandDispatcher as any)._getPlaybackDelayUs();
    };

    const capped = createPipelines(withDecoder({ renderCushionFloorMs: 50, renderCushionMaxMs: 120 }), mockClock, LOC_AV, mockCallbacks());
    schedule(capped);
    expect(capped.getRenderCushionUs!()).toBe(120_000);

    const lifted = createPipelines(withDecoder({ renderCushionFloorMs: 900, congestionControl: 'low-latency' }), mockClock, LOC_AV, mockCallbacks());
    schedule(lifted);
    expect(lifted.getRenderCushionUs!()).toBe(900_000);

    // Low latency, no explicit cap: the catalog target latency is the
    // ceiling, and a config target latency overrides the catalog's.
    const byCatalog = createPipelines(withDecoder({ renderCushionFloorMs: 50, congestionControl: 'low-latency' }), mockClock,
      { ...LOC_AV, targetLatencyMs: 100 }, mockCallbacks());
    schedule(byCatalog);
    expect(byCatalog.getRenderCushionUs!()).toBe(100_000);

    const byConfig = createPipelines(withDecoder({ renderCushionFloorMs: 50, targetLatencyMs: 300, congestionControl: 'low-latency' }), mockClock,
      { ...LOC_AV, targetLatencyMs: 100 }, mockCallbacks());
    schedule(byConfig);
    expect(byConfig.getRenderCushionUs!()).toBe(300_000);

    // An explicit cap still wins over the target.
    const explicit = createPipelines(withDecoder({ renderCushionFloorMs: 50, renderCushionMaxMs: 600 }), mockClock,
      { ...LOC_AV, targetLatencyMs: 100 }, mockCallbacks());
    schedule(explicit);
    expect(explicit.getRenderCushionUs!()).toBe(600_000);
  });

  it('CMAF sessions expose no LOC render cushion', () => {
    const cmaf: TrackInfo = {
      video: { codec: 'avc1.64001e', packaging: 'cmaf' },
      audio: undefined,
    };
    const result = createPipelines(minimalConfig({ createMediaSource: () => ({ initialize: vi.fn(), appendChunk: vi.fn(), endOfStream: vi.fn(), reset: vi.fn(), mediaElement: null, destroy: vi.fn(), onFirstFrame: null, onError: null, onStall: null }) as any }), mockClock, cmaf, mockCallbacks());
    expect(result.getRenderCushionUs).toBeUndefined();
  });
});

describe('createPipelines — LOC cushion cap by requested congestion control', () => {
  const LOC_AV: TrackInfo = {
    video: { codec: 'avc1.64001e', width: 1920, height: 1080, packaging: 'loc' },
    audio: { codec: 'opus', samplerate: 48000, packaging: 'loc' },
  };
  const EXPANDING = ['throughput', 'default', undefined] as const;
  type Mode = (typeof EXPANDING)[number] | 'low-latency';
  const ALL_MODES: readonly Mode[] = [...EXPANDING, 'low-latency'];
  const cc = (mode: Mode): Partial<MoqtPlayerConfig> => (mode ? { congestionControl: mode } : {});

  /** A LOC video session whose gap timeout reads `gapUs()`; frames go straight to decoder output. */
  function session(overrides: Partial<MoqtPlayerConfig>, gapUs: () => number = () => 0, trackInfo: TrackInfo = LOC_AV) {
    let nowUs = 0;
    const clock: ClockSource = { now: () => nowUs };
    const videoDecoder = {
      configure: vi.fn(), decode: vi.fn(), flush: vi.fn(), close: vi.fn(), reset: vi.fn(),
      state: 'configured', decodeQueueSize: 0, ondequeue: null,
      onFrame: null as ((frame: unknown, renderTimeUs: number) => void) | null,
      onError: null as ((error: Error) => void) | null,
    };
    const renderer = {
      enqueue: vi.fn(), flush: vi.fn(), destroy: vi.fn(), start: vi.fn(), stop: vi.fn(),
      onFirstFrame: null, onFrameRendered: null, onStall: null,
    };
    const audioOutput = { schedule: vi.fn(), flush: vi.fn(), destroy: vi.fn(), currentPlayoutTimeUs: 0, realign: vi.fn() };
    const result = createPipelines(minimalConfig({
      createVideoDecoder: () => videoDecoder as any,
      createRenderer: () => renderer as any,
      createAudioOutput: () => audioOutput as any,
      ...overrides,
    }), clock, trackInfo, mockCallbacks());
    Object.defineProperty(result.videoPipeline, 'effectiveGapTimeoutUs', { get: gapUs, configurable: true });
    return {
      result,
      realigns: () => audioOutput.realign.mock.calls.length,
      at: (us: number) => { nowUs = us; },
      schedule: (): number => (result.commandDispatcher as any)._getPlaybackDelayUs(),
      /** Reference: capture 1.0 s renders at 0.1 s. */
      anchor: () => { nowUs = 100_000; result.syncController.setAudioReference(1_000_000n); },
      /** Decoder output for the frame captured at `captureUs`; returns its render time. */
      frame: (captureUs: number): number => {
        videoDecoder.onFrame?.({ timestamp: captureUs, close: vi.fn() } as any, 0);
        return renderer.enqueue.mock.calls.at(-1)![1] as number;
      },
      cushionUs: () => result.getRenderCushionUs!(),
    };
  }
  /** Render time before the cushion for a capture time, under `anchor()`. */
  const baseRenderUs = (captureUs: number) => 100_000 + captureUs - 1_000_000;

  /** The cap: the first scheduled update snaps to min(gap, cap). */
  const capUs = (overrides: Partial<MoqtPlayerConfig>, trackInfo?: TrackInfo): number =>
    session(overrides, () => 10_000_000, trackInfo).schedule();

  it('low-latency holds the live cap; throughput, default and unset take the burst cap', () => {
    expect(capUs(cc('low-latency'))).toBe(RENDER_CUSHION_MAX_US);
    for (const mode of EXPANDING) expect(capUs(cc(mode))).toBe(RENDER_CUSHION_BURST_MAX_US);
  });

  it('an explicit renderCushionMaxMs wins in every mode', () => {
    for (const mode of ALL_MODES) {
      expect(capUs({ renderCushionMaxMs: 1200, ...cc(mode) })).toBe(1_200_000);
    }
  });

  it('the target latency caps only under low latency', () => {
    const target = { ...LOC_AV, targetLatencyMs: 400 };
    expect(capUs(cc('low-latency'), target)).toBe(400_000);
    expect(capUs({ ...cc('low-latency'), targetLatencyMs: 600 }, target)).toBe(600_000);
    expect(capUs({ ...cc('low-latency'), targetLatencyMs: 2000 }, target)).toBe(RENDER_CUSHION_MAX_US);
    for (const mode of EXPANDING) expect(capUs(cc(mode), target)).toBe(RENDER_CUSHION_BURST_MAX_US);
  });

  it('the smooth ceiling takes the burst cap unless low latency is requested', () => {
    expect(session({ latencyMode: 'smooth', ...cc('low-latency') }).result.latencyPolicy?.stats.ceilingMs).toBe(2000);
    for (const mode of EXPANDING) {
      expect(session({ latencyMode: 'smooth', ...cc(mode) }).result.latencyPolicy?.stats.ceilingMs)
        .toBe(RENDER_CUSHION_BURST_MAX_US / 1000);
    }
  });

  it('a sustained high gap timeout slews the cushion up to the burst cap and no further', () => {
    let gapUs = 0;
    const s = session({}, () => gapUs);
    expect(s.schedule()).toBe(200_000);
    gapUs = 3_500_000;
    let prevUs = 200_000;
    for (let t = 1; t <= 40; t++) {
      s.at(t * 1_000_000);
      const us = s.schedule();
      expect(us).toBeGreaterThanOrEqual(prevUs);
      expect(us - prevUs).toBeLessThanOrEqual(RENDER_CUSHION_RISE_US_PER_SEC);
      prevUs = us;
    }
    expect(prevUs).toBe(RENDER_CUSHION_BURST_MAX_US);
  });

  it('a clean steady stream keeps the cushion at the floor', () => {
    const s = session({}, () => 120_000);
    s.anchor();
    for (let i = 0; i <= 600; i++) {
      const captureUs = 1_000_000 + i * 33_333;
      s.at(baseRenderUs(captureUs) + 5_000);   // on time, inside the cushion
      expect(s.frame(captureUs)).toBe(baseRenderUs(captureUs) + 200_000);
      expect(s.cushionUs()).toBe(200_000);
    }
  });

  it('live: late arrivals raise the cushion by their lateness to the cap and the raise holds', () => {
    const s = session({});
    s.anchor();
    s.at(200_000);
    s.frame(1_100_000);
    expect(s.cushionUs()).toBe(200_000);
    // Each arrival 1 s apart in wall time but only 0.6 s apart in capture: 400 ms later than the last.
    let prevUs = 200_000;
    const seen: number[] = [];
    for (let i = 1; i <= 10; i++) {
      const nowUs = 3_200_000 + i * 1_000_000;
      const captureUs = 1_000_000 + nowUs - 100_000 - (i * 400_000 + 300_000);
      s.at(nowUs);
      s.frame(captureUs);
      const us = s.cushionUs();
      expect(us).toBeGreaterThanOrEqual(prevUs);
      expect(us).toBeLessThanOrEqual(RENDER_CUSHION_BURST_MAX_US);
      seen.push(us);
      prevUs = us;
    }
    expect(seen[0]).toBe(200_000 + 500_000 + SMOOTH_MARGIN_US);   // 500 ms past its slot
    expect(seen.some((us) => us > 2_000_000 && us < RENDER_CUSHION_BURST_MAX_US)).toBe(true);
    expect(prevUs).toBe(RENDER_CUSHION_BURST_MAX_US);
    // The raise holds between arrivals.
    const t0 = 3_200_000 + 10 * 1_000_000;
    s.at(t0 + 1_000_000);
    s.schedule();
    expect(s.cushionUs()).toBe(RENDER_CUSHION_BURST_MAX_US);
  });

  /**
   * Bursty arrival from t = 0.2 s for `untilUs`: every `periodUs` the frames
   * captured in that period arrive together, `tailLateUs` after the last one's
   * base render time. Returns the cushion after each burst.
   */
  function bursts(s: ReturnType<typeof session>, periodUs: number, untilUs: number, tailLateUs = 20_000, fromUs = 0) {
    const perBurst = Math.round(periodUs / 33_333);
    const seen: Array<{ atUs: number; cushionUs: number }> = [];
    for (let b = Math.round(fromUs / periodUs); (b + 1) * periodUs <= untilUs; b++) {
      const captures = Array.from({ length: perBurst }, (_, k) => 1_100_000 + (b * perBurst + k) * 33_333);
      const atUs = baseRenderUs(captures.at(-1)!) + tailLateUs;
      s.at(atUs);
      for (const c of captures) s.frame(c);
      seen.push({ atUs, cushionUs: s.cushionUs() });
    }
    return seen;
  }

  it('live: a 450 ms burst pattern raises the cushion once to cover it, then holds', () => {
    for (const mode of EXPANDING) {
      const s = session(cc(mode));
      s.anchor();
      const seen = bursts(s, 450_000, 60_000_000);
      const held = seen.filter((b) => b.atUs >= 5_000_000);
      const heldUs = held[0]!.cushionUs;
      expect(heldUs).toBeGreaterThan(14 * 33_333 + 20_000);   // covers the head's lateness
      expect(heldUs).toBeLessThan(RENDER_CUSHION_BURST_MAX_US);
      for (const b of held) expect(b.cushionUs).toBe(heldUs);
      expect(s.realigns()).toBeLessThanOrEqual(2);
    }
  });

  it('live: a publisher sending each 2.5 s group at once raises the cushion once, then holds', () => {
    const s = session({});
    s.anchor();
    const seen = bursts(s, 2_500_000, 60_000_000);
    const held = seen.filter((b) => b.atUs >= 8_000_000);
    const heldUs = held[0]!.cushionUs;
    expect(heldUs).toBeGreaterThan(2_400_000);
    expect(heldUs).toBeLessThanOrEqual(RENDER_CUSHION_BURST_MAX_US);
    for (const b of held) expect(b.cushionUs).toBe(heldUs);
    expect(s.realigns()).toBeLessThanOrEqual(2);
  });

  it('live: a held cushion steps down only after a clean window, never below the floor', () => {
    const s = session({});
    s.anchor();
    bursts(s, 450_000, 20_000_000);
    const heldUs = s.cushionUs();
    // On-time arrival from 20 s.
    const seen = bursts(s, 33_333, 200_000_000, 5_000, 20_000_000);
    const before = seen.filter((b) => b.atUs < 20_000_000 + SMOOTH_CLEAN_WINDOW_US - 1_000_000);
    for (const b of before) expect(b.cushionUs).toBe(heldUs);
    const lowered = seen.find((b) => b.cushionUs < heldUs)!;
    expect(lowered.atUs).toBeGreaterThanOrEqual(20_000_000 + SMOOTH_CLEAN_WINDOW_US);
    const lastUs = seen.at(-1)!.cushionUs;
    expect(lastUs).toBeLessThan(heldUs);
    expect(lastUs).toBeGreaterThanOrEqual(200_000);
  });

  it('live: a later, larger lateness raises a held cushion again', () => {
    const s = session({});
    s.anchor();
    bursts(s, 450_000, 20_000_000);
    const heldUs = s.cushionUs();
    const realigns = s.realigns();
    // The next burst lands 1.2 s past its tail's base render time.
    bursts(s, 450_000, 20_450_000, 1_200_000, 20_000_000);
    expect(s.cushionUs()).toBeGreaterThan(heldUs + 500_000);
    expect(s.realigns()).toBe(realigns + 1);
  });

  it('low latency: a 450 ms burst pattern leaves the live cushion at the floor', () => {
    const s = session(cc('low-latency'));
    s.anchor();
    for (const b of bursts(s, 450_000, 30_000_000)) expect(b.cushionUs).toBe(200_000);
    expect(s.realigns()).toBe(0);
  });

  it('live: lateness inside the startup grace does not raise the cushion', () => {
    const s = session({});
    s.anchor();
    s.at(200_000);
    s.frame(1_100_000);
    s.at(2_000_000);
    s.frame(1_100_000);   // 1.7 s late, 1.8 s after the first arrival
    expect(s.cushionUs()).toBe(200_000);
  });

  it('low latency: late arrivals never raise the live cushion', () => {
    {
      const s = session(cc('low-latency'));
      s.anchor();
      s.at(200_000);
      s.frame(1_100_000);
      for (let i = 1; i <= 5; i++) {
        s.at(3_200_000 + i * 1_000_000);
        s.frame(1_100_000 + i * 100_000);
      }
      expect(s.cushionUs()).toBe(200_000);
    }
  });

  it('smooth: repeated late arrivals raise the cushion to the burst cap, never past it', () => {
    const s = session({ latencyMode: 'smooth' });
    s.anchor();
    s.at(200_000);
    s.frame(1_100_000);
    let prevUs = s.cushionUs();
    const seen: number[] = [];
    for (let i = 1; i <= 10; i++) {
      const nowUs = 3_200_000 + i * 1_000_000;
      s.at(nowUs);
      s.frame(1_100_000 + nowUs - 200_000 - i * 400_000 - 1_000_000);
      const us = s.cushionUs();
      expect(us).toBeGreaterThanOrEqual(prevUs);
      expect(us).toBeLessThanOrEqual(RENDER_CUSHION_BURST_MAX_US);
      seen.push(us);
      prevUs = us;
    }
    expect(seen.some((us) => us > 2_000_000 && us < RENDER_CUSHION_BURST_MAX_US)).toBe(true);
    expect(prevUs).toBe(RENDER_CUSHION_BURST_MAX_US);
  });

  it('a burst arriving inside the cushion presents at even frame spacing, not at arrival', () => {
    for (const mode of EXPANDING) {
      // A 500 ms cushion; each 15-frame burst lands 20 ms after its last frame's base render time,
      // so its head is ~490 ms behind base time (past the 100 ms drop threshold) yet inside the cushion.
      const s = session({ renderCushionFloorMs: 500, ...cc(mode) });
      s.anchor();
      const times: number[] = [];
      for (let burst = 0; burst < 4; burst++) {
        const captures = Array.from({ length: 15 }, (_, k) => 1_000_000 + (burst * 15 + k) * 33_333);
        s.at(baseRenderUs(captures.at(-1)!) + 20_000);
        for (const c of captures) times.push(s.frame(c));
      }
      const spacing = times.slice(1).map((t, i) => t - times[i]!);
      expect(Math.min(...spacing)).toBeGreaterThanOrEqual(33_000);
      expect(Math.max(...spacing)).toBeLessThanOrEqual(33_700);
    }
  });
});

describe('createPipelines — apply to a running session', () => {
  function locVideo(overrides: Partial<MoqtPlayerConfig> = {}) {
    let nowUs = 0;
    const clock: ClockSource = { now: () => nowUs };
    const videoDecoder = {
      configure: vi.fn(), decode: vi.fn(), flush: vi.fn(), close: vi.fn(), reset: vi.fn(),
      state: 'configured', decodeQueueSize: 0, ondequeue: null,
      onFrame: null as ((frame: unknown, renderTimeUs: number) => void) | null,
      onError: null as ((error: Error) => void) | null,
    };
    const renderer = {
      enqueue: vi.fn(), flush: vi.fn(), destroy: vi.fn(), start: vi.fn(), stop: vi.fn(),
      onFirstFrame: null, onFrameRendered: null, onStall: null,
    };
    const audioOutput = { schedule: vi.fn(), flush: vi.fn(), destroy: vi.fn(), currentPlayoutTimeUs: 0, realign: vi.fn() };
    const config = minimalConfig({
      createVideoDecoder: () => videoDecoder as any,
      createRenderer: () => renderer as any,
      createAudioOutput: () => audioOutput as any,
      ...overrides,
    });
    const result = createPipelines(config, clock,
      { video: { codec: 'avc1.64001e', packaging: 'loc' }, audio: undefined }, mockCallbacks());
    Object.defineProperty(result.videoPipeline, 'effectiveGapTimeoutUs', { get: () => 0, configurable: true });
    return {
      config, result, videoDecoder, renderer, audioOutput,
      at: (us: number) => { nowUs = us; },
      schedule: () => (result.commandDispatcher as any)._getPlaybackDelayUs(),
    };
  }

  it('live to smooth raises the next frame\'s slot to the smooth floor and realigns audio', () => {
    const s = locVideo();
    s.at(100_000);
    s.result.syncController.setAudioReference(1_000_000n);   // capture 1.0 s renders at 0.1 s
    s.at(200_000);
    s.videoDecoder.onFrame?.({ timestamp: 1_100_000, close: vi.fn() } as any, 0);   // slot 0.2 + 0.2 cushion
    expect(s.result.apply!({ ...s.config, latencyMode: 'smooth' }, undefined)?.mode).toBe('smooth');
    expect(s.result.latencyPolicy?.stats).toMatchObject({ heldMs: 1000, floorMs: 1000 });
    expect(s.result.getRenderCushionUs!()).toBe(1_000_000);
    expect(s.audioOutput.realign).toHaveBeenCalledTimes(1);
    s.at(233_333);
    s.videoDecoder.onFrame?.({ timestamp: 1_133_333, close: vi.fn() } as any, 0);
    expect(s.renderer.enqueue.mock.calls.map((c) => c[1])).toEqual([400_000, 233_333 + 1_000_000]);
  });

  it('smooth to live drops the policy and the cushion slews down to the live cap', () => {
    const s = locVideo({ latencyMode: 'smooth' });
    expect(s.result.getRenderCushionUs!()).toBe(1_000_000);
    expect(s.result.apply!({ ...s.config, latencyMode: 'live' }, undefined)).toBeUndefined();
    expect(s.result.latencyPolicy).toBeUndefined();
    expect(s.audioOutput.realign).not.toHaveBeenCalled();
    s.at(1_000_000);
    s.schedule();
    expect(s.result.getRenderCushionUs!()).toBe(1_000_000 - RENDER_CUSHION_FALL_US_PER_SEC);
    s.at(60_000_000);
    s.schedule();
    expect(s.result.getRenderCushionUs!()).toBe(200_000);
  });

  it('a cushion floor change moves the cushion to the new floor at the slew rates', () => {
    const s = locVideo();
    s.schedule();
    expect(s.result.getRenderCushionUs!()).toBe(200_000);
    s.result.apply!({ ...s.config, renderCushionFloorMs: 500 }, undefined);
    s.at(1_000_000);
    s.schedule();
    expect(s.result.getRenderCushionUs!()).toBe(200_000 + RENDER_CUSHION_RISE_US_PER_SEC);
    s.at(4_000_000);
    s.schedule();
    expect(s.result.getRenderCushionUs!()).toBe(500_000);
    s.result.apply!({ ...s.config, renderCushionFloorMs: 100 }, undefined);
    s.at(5_000_000);
    s.schedule();
    expect(s.result.getRenderCushionUs!()).toBe(500_000 - RENDER_CUSHION_FALL_US_PER_SEC);
  });
});
