/**
 * WebCodecsAudioEncoder — encodes AudioData to Opus/AAC via browser AudioEncoder.
 *
 * Mirrors the WebCodecsAudioDecoder pattern: configure → encode → onChunk callback.
 * Used by the broadcast example to encode microphone audio for MoQ publishing.
 *
 * @see draft-ietf-moq-loc-01 §4.1 (audio independently decodable)
 * @module
 */

/** Default audio bitrate in bits per second. */
const DEFAULT_AUDIO_BITRATE = 128_000;

/** An input stamp this far from its sample-count prediction starts a new segment. */
const DISCONTINUITY_US = 5_000;

/** A run of input whose stamps follow its sample count. */
interface InputSegment {
  /** Media position (µs of samples fed before it) where the segment starts. */
  mediaUs: number;
  /** Capture timestamp of its first sample, µs. */
  timestampUs: number;
}

/**
 * Browser AudioEncoder wrapper for MoQ publishing.
 *
 * Each chunk is stamped with the capture time of its first input sample,
 * mapped through the sample count, rather than the encoder's own stamp,
 * which need not follow gaps in the input.
 *
 * Usage:
 * ```ts
 * const encoder = new WebCodecsAudioEncoder();
 * encoder.onChunk = (data, timestamp, duration) => {
 *   // data: raw encoded bytes (Opus or AAC)
 *   // timestamp: capture timestamp in microseconds
 *   // duration: chunk duration in microseconds
 * };
 * encoder.configure('opus', 48000, 2);
 * // In capture loop:
 * encoder.encode(audioData);
 * ```
 */
export class WebCodecsAudioEncoder {
  private encoder: AudioEncoder | null = null;

  /** Callback: encoded chunk ready for publishing. */
  onChunk: ((
    data: Uint8Array,
    timestamp: number,
    duration: number,
  ) => void) | null = null;

  /** Callback: encoder error. */
  onError: ((error: Error) => void) | null = null;

  /**
   * Callback: an input stamp left its sample-count prediction by `deltaUs`
   * (positive: samples missing) at input `timestampUs`.
   */
  onInputDiscontinuity: ((deltaUs: number, timestampUs: number) => void) | null = null;

  private segments: InputSegment[] = [];
  /** Media time fed to the encoder, µs. */
  private inputMediaUs = 0;
  /** Media time emitted by the encoder, µs. */
  private outputMediaUs = 0;

  /**
   * Configure the audio encoder.
   *
   * @param codec Codec string (e.g., 'opus', 'mp4a.40.2')
   * @param sampleRate Sample rate in Hz (e.g., 48000)
   * @param channels Number of audio channels (e.g., 2 for stereo)
   * @param options Encoding options
   */
  configure(
    codec: string,
    sampleRate: number,
    channels: number,
    options?: {
      bitrate?: number;
    },
  ): void {
    this.segments = [];
    this.inputMediaUs = 0;
    this.outputMediaUs = 0;
    this.encoder = new AudioEncoder({
      output: (chunk: EncodedAudioChunk) => {
        const data = new Uint8Array(chunk.byteLength);
        chunk.copyTo(data);

        // Without a duration the media position cannot advance.
        const duration = chunk.duration ?? 0;
        const timestamp = duration > 0
          ? this.captureTimestampAt(this.outputMediaUs) ?? chunk.timestamp
          : chunk.timestamp;
        this.outputMediaUs += duration;
        this.onChunk?.(data, timestamp, duration);
      },
      error: (err: DOMException) => {
        this.onError?.(new Error(err.message));
      },
    });

    this.encoder.configure({
      codec,
      sampleRate,
      numberOfChannels: channels,
      bitrate: options?.bitrate ?? DEFAULT_AUDIO_BITRATE,
    });
  }

  /**
   * Encode an AudioData chunk.
   *
   * The AudioData is NOT closed — caller retains ownership.
   *
   * @param data AudioData from MediaStreamTrackProcessor
   */
  encode(data: AudioData): void {
    if (!this.encoder || this.encoder.state !== 'configured') return;
    this.noteInput(data);
    this.encoder.encode(data);
  }

  /** Start a new segment when the input's stamp leaves its predicted position. */
  private noteInput(data: AudioData): void {
    const last = this.segments[this.segments.length - 1];
    const predictedUs = last ? last.timestampUs + (this.inputMediaUs - last.mediaUs) : null;
    if (predictedUs === null || Math.abs(data.timestamp - predictedUs) > DISCONTINUITY_US) {
      if (predictedUs !== null) {
        this.onInputDiscontinuity?.(data.timestamp - predictedUs, data.timestamp);
      }
      this.segments.push({ mediaUs: this.inputMediaUs, timestampUs: data.timestamp });
    }
    this.inputMediaUs += (data.numberOfFrames / data.sampleRate) * 1e6;
  }

  /** Capture time of the input sample at media position `mediaUs`. */
  private captureTimestampAt(mediaUs: number): number | null {
    // Keeps the last segment: noteInput predicts from it.
    while (this.segments.length > 1 && this.segments[1]!.mediaUs <= mediaUs) this.segments.shift();
    const seg = this.segments[0];
    return seg && seg.mediaUs <= mediaUs ? seg.timestampUs + (mediaUs - seg.mediaUs) : null;
  }

  /** Flush pending audio. */
  async flush(): Promise<void> {
    if (!this.encoder || this.encoder.state !== 'configured') return;
    await this.encoder.flush();
  }

  /** Release all resources. */
  destroy(): void {
    if (this.encoder && this.encoder.state !== 'closed') {
      this.encoder.close();
    }
    this.encoder = null;
  }

  /** Current encode queue depth. */
  get queueDepth(): number {
    return this.encoder?.encodeQueueSize ?? 0;
  }
}
