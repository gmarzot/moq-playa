/**
 * Soft live-edge chase: play slightly fast while the cushion ahead of the
 * playhead exceeds the target, shedding latency debt too small for a seek.
 * A stall that begins during a chase raises the cushion the chase stops at,
 * so the chase never again drains the buffer into a level that stalled.
 *
 * @module
 */

/** The element property the chase drives. */
export interface ChasedElement {
  playbackRate: number;
}

export class SoftChase {
  /** Playback rate while shedding cushion above target; inaudible. */
  static readonly RATE = 1.05;
  /** Engage once the cushion exceeds the release point by this share of the
   *  target (at least ON_MIN_SEC). Same band as the WebAudio chase. */
  static readonly ON_RATIO = 0.66;
  static readonly ON_MIN_SEC = 0.02;

  /** Cushion (s) at which a stall began during a chase, plus one frame. */
  private floorSec = 0;
  /** Duration (s) of the latest video sample. */
  private sampleSec: number | null = null;

  constructor(
    private readonly element: ChasedElement,
    private readonly targetSec: () => number,
  ) {}

  get chasing(): boolean {
    return this.element.playbackRate !== 1;
  }

  /** The cushion a chase stops at: the target, or above a level a chase has stalled at. */
  get releaseSec(): number {
    return Math.max(this.targetSec(), this.floorSec);
  }

  /** Cushion measured after new media lands: engage above the band, release at the release point. */
  onCushion(aheadSec: number): void {
    const margin = Math.max(SoftChase.ON_MIN_SEC, this.targetSec() * SoftChase.ON_RATIO);
    if (aheadSec > this.releaseSec + margin) {
      if (this.element.playbackRate === 1) this.element.playbackRate = SoftChase.RATE;
    } else if (aheadSec <= this.releaseSec) {
      this.stop();
    }
  }

  /** Cushion measured before new media lands, its low point: release at the release point. */
  onLowPoint(aheadSec: number): void {
    if (this.chasing && aheadSec <= this.releaseSec) this.stop();
  }

  /** A stall began with `aheadSec` buffered. During a chase, returns the raised floor; else null. */
  onStall(aheadSec: number): number | null {
    if (!this.chasing) return null;
    const floor = aheadSec + (this.sampleSec ?? 0);
    if (floor <= this.floorSec) return null;
    this.floorSec = floor;
    this.stop();
    return floor;
  }

  noteSampleDuration(sec: number): void {
    this.sampleSec = sec;
  }

  /** End a chase; a seek, pause or reset must not carry the rate over. */
  stop(): void {
    if (this.element.playbackRate !== 1) this.element.playbackRate = 1;
  }

  /** New session: forget the floor and the sample duration. */
  reset(): void {
    this.floorSec = 0;
    this.sampleSec = null;
  }
}
