/**
 * LatencyPolicy — the viewer's latency choice for live playback.
 *
 * `live` holds playout at the target: media that misses its slot is skipped or
 * dropped, and a chase sheds any backlog. `smooth` trades latency for
 * continuity: an arrival past its slot raises the playout delay by its
 * lateness plus a margin, up to a ceiling, so late media plays instead of
 * being skipped. After a window with no late arrival the delay steps down by
 * at most the slack every arrival in that window had to spare, so it never
 * falls into a level that just failed.
 *
 * Path-agnostic: the LOC pipeline reports each decoded frame's slack against
 * the render cushion; the MSE path reports buffer low points and stalls.
 *
 * @module
 */

import type { ClockSource } from '@openmoq/playback';

export type LatencyMode = 'live' | 'smooth';

/** Default ceiling of the smooth playout delay. */
export const SMOOTH_CEILING_MS = 2000;
/** Headroom added above an arrival's lateness when the delay rises. */
export const SMOOTH_MARGIN_US = 50_000;
/** A window this long with no late arrival lets the delay step down. */
export const SMOOTH_CLEAN_WINDOW_US = 30_000_000;

export interface LatencyPolicyOptions {
  readonly mode: LatencyMode;
  /** Delay the path holds without the policy (µs); smooth never steps below it. */
  readonly baseUs: number;
  /** Smooth ceiling (µs). Default {@link SMOOTH_CEILING_MS}. */
  readonly ceilingUs?: number;
  readonly marginUs?: number;
  readonly cleanWindowUs?: number;
}

export interface LatencyStats {
  readonly mode: LatencyMode;
  /** Playout delay smooth mode holds (ms); the base in live mode. */
  readonly heldMs: number;
  readonly ceilingMs: number;
  /** Times a late arrival raised the delay. */
  readonly raises: number;
  /** Times a clean window lowered it. */
  readonly lowers: number;
}

export class LatencyPolicy {
  readonly mode: LatencyMode;
  readonly ceilingUs: number;
  private baseUs: number;
  private readonly marginUs: number;
  private readonly cleanWindowUs: number;
  private readonly clock: ClockSource;

  /** The delay raises hold, 0 before any; the held delay is never below the base. */
  private raisedUs = 0;
  private windowStartUs: number | null = null;
  private windowMinSlackUs = Infinity;
  private _raises = 0;
  private _lowers = 0;

  constructor(options: LatencyPolicyOptions, clock: ClockSource) {
    this.mode = options.mode;
    this.baseUs = options.baseUs;
    this.ceilingUs = Math.max(options.ceilingUs ?? SMOOTH_CEILING_MS * 1000, options.baseUs);
    this.marginUs = options.marginUs ?? SMOOTH_MARGIN_US;
    this.cleanWindowUs = options.cleanWindowUs ?? SMOOTH_CLEAN_WINDOW_US;
    this.clock = clock;
  }

  /** The delay smooth mode holds (µs): at least the base, at most the ceiling. */
  get heldUs(): number {
    return Math.min(Math.max(this.raisedUs, this.baseUs), Math.max(this.ceilingUs, this.baseUs));
  }

  get raises(): number {
    return this._raises;
  }

  get lowers(): number {
    return this._lowers;
  }

  /** A new base (e.g. the catalog target); a raised delay above it stays. */
  setBase(baseUs: number): void {
    this.baseUs = baseUs;
  }

  /**
   * One arrival's slack against the delay in force (`delayUs`): negative is
   * late by that much. Returns the new held delay when it changed, else null.
   * Live mode never changes it.
   */
  noteArrival(slackUs: number, delayUs: number): number | null {
    if (this.mode !== 'smooth') return null;
    const nowUs = this.clock.now();
    if (slackUs < 0) {
      this.restartWindow(nowUs);
      const next = Math.min(this.ceilingUs, delayUs - slackUs + this.marginUs);
      if (next <= this.heldUs) return null;
      this.raisedUs = next;
      this._raises++;
      return this.heldUs;
    }
    if (this.windowStartUs === null) this.windowStartUs = nowUs;
    this.windowMinSlackUs = Math.min(this.windowMinSlackUs, slackUs);
    if (nowUs - this.windowStartUs < this.cleanWindowUs) return null;
    // Clean window: step down by the spare slack, at most half the excess.
    const excessUs = this.heldUs - this.baseUs;
    const stepUs = Math.min(this.windowMinSlackUs - this.marginUs, excessUs / 2);
    this.restartWindow(nowUs);
    if (excessUs <= 0 || stepUs <= 0) return null;
    this.raisedUs = excessUs - stepUs < 1000 ? 0 : this.heldUs - stepUs;
    this._lowers++;
    return this.heldUs;
  }

  get stats(): LatencyStats {
    return {
      mode: this.mode,
      heldMs: this.heldUs / 1000,
      ceilingMs: this.ceilingUs / 1000,
      raises: this._raises,
      lowers: this._lowers,
    };
  }

  private restartWindow(nowUs: number): void {
    this.windowStartUs = nowUs;
    this.windowMinSlackUs = Infinity;
  }
}
