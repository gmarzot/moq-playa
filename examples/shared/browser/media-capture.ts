/**
 * MediaCapture — captures camera/screen via getUserMedia/getDisplayMedia.
 *
 * Uses MediaStreamTrackProcessor (Chrome 94+) to extract VideoFrame and
 * AudioData objects from a MediaStream, feeding them to encoder adapters.
 *
 * @see https://developer.mozilla.org/en-US/docs/Web/API/MediaStreamTrackProcessor
 * @module
 */

import { programmeAudio } from './programme-audio.js';

/** AudioData the microphone processor holds while the page is busy (~10 ms
 *  each); past it the processor drops input. */
const AUDIO_BUFFER_FRAMES = 50;

/** Camera choice: `front`, `back`, a device id, or null for the browser default. */
export type CameraChoice = string | null;

/** Video constraints for `camera` on top of `base` (size, frame rate). */
export function cameraConstraints(base: MediaTrackConstraints | undefined, camera: CameraChoice): MediaTrackConstraints | true {
  if (!camera) return base ?? true;
  const choice: MediaTrackConstraints = camera === 'front' ? { facingMode: 'user' }
    // exact: an ideal facing mode competes with the size and can still pick the front camera.
    : camera === 'back' ? { facingMode: { exact: 'environment' } }
      : { deviceId: { exact: camera } };
  return { ...base, ...choice };
}

function isOverconstrained(err: unknown): boolean {
  return (err as { name?: unknown } | null)?.name === 'OverconstrainedError';
}

/**
 * Captures media from camera or screen and delivers raw frames.
 *
 * Usage:
 * ```ts
 * const capture = new MediaCapture();
 * capture.onVideoFrame = (frame) => {
 *   encoder.encode(frame);
 *   frame.close(); // caller MUST close
 * };
 * const stream = await capture.startCamera({ width: 1280, height: 720 });
 * // stream can be assigned to <video>.srcObject for local preview
 * ```
 */
export class MediaCapture {
  private stream: MediaStream | null = null;
  private videoAbort: AbortController | null = null;
  private audioAbort: AbortController | null = null;

  /** Callback: video frame captured. Caller MUST call frame.close(). */
  onVideoFrame: ((frame: VideoFrame) => void) | null = null;

  /** Callback: audio data captured. Caller MUST call data.close(). */
  onAudioData: ((data: AudioData) => void) | null = null;

  /** Callback: capture error. */
  onError: ((error: Error) => void) | null = null;

  /** Callback: the chosen camera is not available; the default camera opened instead. */
  onCameraFallback: ((camera: string, error: Error) => void) | null = null;

  /**
   * Start capturing from camera (+ microphone if available).
   *
   * @param constraints Video constraints (width, height, frameRate, etc.)
   * @param camera Camera to open; one that cannot be satisfied falls back to the default
   * @returns The MediaStream (assign to <video>.srcObject for preview)
   */
  async startCamera(
    constraints?: MediaTrackConstraints,
    audio: boolean | MediaTrackConstraints = true,
    camera: CameraChoice = null,
  ): Promise<MediaStream> {
    const open = (video: MediaTrackConstraints | true) =>
      navigator.mediaDevices.getUserMedia({ video, audio: programmeAudio(audio) });
    let stream: MediaStream;
    try {
      stream = await open(cameraConstraints(constraints, camera));
    } catch (err) {
      if (!camera || !isOverconstrained(err)) throw err;
      this.onCameraFallback?.(camera, err instanceof Error ? err : new Error(String(err)));
      stream = await open(cameraConstraints(constraints, null));
    }
    return this.processStream(stream);
  }

  /**
   * Start capturing from screen (+ system audio if available).
   *
   * @param constraints Display media constraints
   * @returns The MediaStream
   */
  async startScreen(constraints?: DisplayMediaStreamOptions): Promise<MediaStream> {
    const options = constraints ?? { video: true, audio: true };
    const stream = await navigator.mediaDevices.getDisplayMedia(options.audio === undefined
      ? options : { ...options, audio: programmeAudio(options.audio) });
    return this.processStream(stream);
  }

  /** Stop all capture and release resources. */
  stop(): void {
    this.videoAbort?.abort();
    this.audioAbort?.abort();
    this.videoAbort = null;
    this.audioAbort = null;

    if (this.stream) {
      for (const track of this.stream.getTracks()) {
        track.stop();
      }
      this.stream = null;
    }
  }

  /** The active MediaStream (for local preview). */
  get mediaStream(): MediaStream | null {
    return this.stream;
  }

  /** Video track settings (width, height, frameRate). */
  get videoSettings(): MediaTrackSettings | null {
    const track = this.stream?.getVideoTracks()[0];
    return track?.getSettings() ?? null;
  }

  // ─── Internal ─────────────────────────────────────────────────

  private processStream(stream: MediaStream): MediaStream {
    this.stop(); // clean up previous capture
    this.stream = stream;

    // Process video track
    const videoTrack = stream.getVideoTracks()[0];
    if (videoTrack) {
      this.videoAbort = new AbortController();
      this.readVideoFrames(videoTrack, this.videoAbort.signal);
    }

    // Process audio track
    const audioTrack = stream.getAudioTracks()[0];
    if (audioTrack) {
      this.audioAbort = new AbortController();
      this.readAudioData(audioTrack, this.audioAbort.signal);
    }

    return stream;
  }

  private async readVideoFrames(track: MediaStreamTrack, signal: AbortSignal): Promise<void> {
    try {
      // @ts-expect-error MediaStreamTrackProcessor is not yet in TypeScript lib
      const processor = new MediaStreamTrackProcessor({ track });
      const reader: ReadableStreamDefaultReader<VideoFrame> = processor.readable.getReader();

      while (!signal.aborted) {
        const { value: frame, done } = await reader.read();
        if (done || signal.aborted) {
          frame?.close();
          break;
        }
        if (this.onVideoFrame) {
          this.onVideoFrame(frame);
        } else {
          frame.close(); // MUST close if no consumer
        }
      }
      reader.releaseLock();
    } catch (err) {
      if (!signal.aborted) {
        this.onError?.(err instanceof Error ? err : new Error(String(err)));
      }
    }
  }

  private async readAudioData(track: MediaStreamTrack, signal: AbortSignal): Promise<void> {
    try {
      // @ts-expect-error MediaStreamTrackProcessor is not yet in TypeScript lib
      const processor = new MediaStreamTrackProcessor({ track, maxBufferSize: AUDIO_BUFFER_FRAMES });
      const reader: ReadableStreamDefaultReader<AudioData> = processor.readable.getReader();

      while (!signal.aborted) {
        const { value: data, done } = await reader.read();
        if (done || signal.aborted) {
          data?.close();
          break;
        }
        if (this.onAudioData) {
          this.onAudioData(data);
        } else {
          data.close(); // MUST close if no consumer
        }
      }
      reader.releaseLock();
    } catch (err) {
      if (!signal.aborted) {
        this.onError?.(err instanceof Error ? err : new Error(String(err)));
      }
    }
  }
}
