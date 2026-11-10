/**
 * AudioRepair — recovers lost audio datagrams with FETCH.
 *
 * A skipped Location in the datagram sequence opens a gap. After a short wait
 * for a reordered arrival, one FETCH asks for the gap's range. A gap ends when
 * its objects arrive or at the deadline; either way its request is cancelled
 * to release the request stream. Repeated failures, as on a relay that does not
 * keep recent audio, pause the repair.
 *
 * @module
 */

/** A FETCH range: the end is one past the last object, object 0 the whole end group. */
export interface AudioRepairRange {
  readonly startGroup: bigint;
  readonly startObject: bigint;
  readonly endGroup: bigint;
  readonly endObject: bigint;
}

export interface AudioRepairStats {
  /** Gaps seen. */
  readonly gaps: number;
  /** Objects recovered. */
  readonly filled: number;
  /** Objects asked for and not recovered by the deadline. */
  readonly failed: number;
  /** False while repeated failures have paused the repair. */
  readonly active: boolean;
}

export interface AudioRepairOptions {
  readonly fetch: (range: AudioRepairRange) => Promise<bigint>;
  readonly cancel: (requestId: bigint) => void;
  readonly onGiveUp?: () => void;
  readonly graceMs?: number;
  readonly deadlineMs?: number;
  readonly maxInFlight?: number;
  /** A gap missing more objects than this is a discontinuity, not loss. */
  readonly maxGapObjects?: number;
  /** Consecutive failed gaps before the repair pauses. */
  readonly giveUpAfter?: number;
  readonly pauseMs?: number;
}

interface Gap {
  readonly range: AudioRepairRange;
  readonly missing: Set<string>;
  timer: ReturnType<typeof setTimeout>;
  sent: boolean;
  closed: boolean;
  requestId: bigint | null;
}

const key = (group: bigint, object: bigint): string => `${group}:${object}`;

export class AudioRepair {
  /** Wait for a reordered datagram before fetching. */
  static readonly DEFAULT_GRACE_MS = 30;
  /** Longest a gap stays open once its FETCH is sent. */
  static readonly DEFAULT_DEADLINE_MS = 370;

  private readonly graceMs: number;
  private readonly deadlineMs: number;
  private readonly maxInFlight: number;
  private readonly maxGapObjects: number;
  private readonly giveUpAfter: number;
  private readonly pauseMs: number;
  private resumeTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly open = new Set<Gap>();
  private last: { group: bigint; object: bigint } | null = null;
  private inFlight = 0;
  private gaps = 0;
  private filled = 0;
  private failed = 0;
  private failedInARow = 0;
  private active = true;

  constructor(private readonly options: AudioRepairOptions) {
    this.graceMs = options.graceMs ?? AudioRepair.DEFAULT_GRACE_MS;
    this.deadlineMs = options.deadlineMs ?? AudioRepair.DEFAULT_DEADLINE_MS;
    this.maxInFlight = options.maxInFlight ?? 3;
    this.maxGapObjects = options.maxGapObjects ?? 50;
    this.giveUpAfter = options.giveUpAfter ?? 8;
    this.pauseMs = options.pauseMs ?? 60_000;
  }

  get stats(): AudioRepairStats {
    return { gaps: this.gaps, filled: this.filled, failed: this.failed, active: this.active };
  }

  /** How long a gap can stay open, for a pipeline holding later objects behind it. */
  get holdMs(): number {
    return this.graceMs + this.deadlineMs;
  }

  /** A datagram arrived. */
  note(group: bigint, object: bigint): void {
    if (!this.active) return;
    this.settleUnsent(group, object);
    const last = this.last;
    if (last !== null && (group < last.group || (group === last.group && object <= last.object))) return;
    this.last = { group, object };
    if (last !== null) this.openGap(last, group, object);
  }

  /** A fetched object arrived. */
  noteFetched(group: bigint, object: bigint): void {
    const k = key(group, object);
    for (const gap of this.open) {
      if (!gap.sent || !gap.missing.delete(k)) continue;
      this.filled++;
      this.failedInARow = 0;
      if (gap.missing.size === 0) this.close(gap);
      return;
    }
  }

  /** Forget everything in flight and start over; for a new session or track. */
  reset(): void {
    for (const gap of [...this.open]) this.close(gap);
    if (this.resumeTimer !== null) clearTimeout(this.resumeTimer);
    this.resumeTimer = null;
    this.resume();
  }

  private resume(): void {
    this.last = null;
    this.failedInARow = 0;
    this.active = true;
  }

  private settleUnsent(group: bigint, object: bigint): void {
    const k = key(group, object);
    for (const gap of this.open) {
      if (gap.sent || !gap.missing.delete(k)) continue;
      if (gap.missing.size === 0) this.close(gap);
      return;
    }
  }

  private openGap(last: { group: bigint; object: bigint }, group: bigint, object: bigint): void {
    const missing = new Set<string>();
    const sameGroup = group === last.group;
    const objectSpan = sameGroup ? object - last.object : object;
    if (group - last.group > BigInt(this.maxGapObjects) || objectSpan > BigInt(this.maxGapObjects)) return;
    for (let g = last.group + 1n; g < group; g++) missing.add(key(g, 0n));
    for (let o = sameGroup ? last.object + 1n : 0n; o < object; o++) missing.add(key(group, o));
    if (missing.size === 0 || missing.size > this.maxGapObjects) return;
    this.gaps++;
    const range: AudioRepairRange = {
      startGroup: sameGroup ? group : (group > last.group + 1n ? last.group + 1n : group),
      startObject: sameGroup ? last.object + 1n : 0n,
      endGroup: object > 0n ? group : group - 1n,
      endObject: object > 0n ? object : 0n,
    };
    const gap: Gap = {
      range, missing, sent: false, closed: false, requestId: null,
      timer: setTimeout(() => this.send(gap), this.graceMs),
    };
    this.open.add(gap);
  }

  private send(gap: Gap): void {
    if (this.inFlight >= this.maxInFlight) {
      this.failed += gap.missing.size;
      this.close(gap);
      return;
    }
    gap.sent = true;
    this.inFlight++;
    gap.timer = setTimeout(() => this.fail(gap), this.deadlineMs);
    this.options.fetch(gap.range).then((requestId) => {
      gap.requestId = requestId;
      if (gap.closed) this.options.cancel(requestId);
    }, () => { if (!gap.closed) this.fail(gap); });
  }

  private fail(gap: Gap): void {
    this.failed += gap.missing.size;
    this.failedInARow++;
    this.close(gap);
    if (this.failedInARow < this.giveUpAfter) return;
    this.active = false;
    for (const other of [...this.open]) this.close(other);
    this.resumeTimer = setTimeout(() => { this.resumeTimer = null; this.resume(); }, this.pauseMs);
    this.options.onGiveUp?.();
  }

  private close(gap: Gap): void {
    if (gap.closed) return;
    gap.closed = true;
    clearTimeout(gap.timer);
    this.open.delete(gap);
    if (gap.sent) this.inFlight--;
    if (gap.requestId !== null) this.options.cancel(gap.requestId);
  }
}
