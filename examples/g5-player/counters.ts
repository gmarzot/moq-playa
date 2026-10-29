/**
 * G5 Player counter logic: per-track object continuity, the stalls cell, and
 * whether the picture is frozen. Pure state; the page owns the DOM and logging.
 */

// ── Object continuity ──────────────────────────────────────────────

// Arrival order is not delivery order: LOC audio is one group per frame on its
// own QUIC stream (~47/s), and independent streams carry no ordering guarantee
// between them, so adjacent ids routinely race. A high-water mark plus a pending
// set separates the two cases — an id that lands late and fills its own hole is
// a reorder, one still missing after the settle window is loss. Loss inside a
// buffered range is what a stall with data still ahead of the playhead looks
// like from here.
export const REORDER_SETTLE_MS = 1_000;
/** Past this a jump is a restart or a join, not a hole worth enumerating. */
export const SEQ_JUMP_CAP = 200n;
/** Settle times age out: a lifetime maximum stops describing current conditions. */
export const SETTLE_WINDOW_MS = 45_000;

export interface ObjSeq {
  group: bigint; object: bigint;        // high-water mark, not last seen
  pending: Map<string, number>;
  reorders: number; lost: number;
  settles: Array<[number, number]>;     // [arrival, settle ms]
  rebase?: boolean;                     // the next newer id restarts the sequence
  dropPending?: boolean;                // and the rebase gives up the holes still pending
}

/** What one arrival changed: ids newly given up as lost, or a jump past the cap. */
export interface SeqNote {
  lost: number;
  firstLostKey: string;
  jump: string | null;
}

/**
 * Restart a track's sequence (every track's without `track`) at its next newer
 * id, for gaps that are not loss. `dropPending` is for outages (reconnect,
 * migration, resubscribe): the holes still pending will never fill. A pause
 * keeps them, so a straggler still matches and a real loss still counts.
 */
export function rebaseSeqs(
  seqs: Record<string, ObjSeq>, opts: { dropPending: boolean; track?: string },
): void {
  for (const [k, s] of Object.entries(seqs)) {
    if (opts.track !== undefined && k !== opts.track) continue;
    s.rebase = true;
    if (opts.dropPending) s.dropPending = true;
  }
}

/** Account one arriving object id on track `t`. */
export function noteSeq(
  seqs: Record<string, ObjSeq>, t: string, group: bigint, object: bigint, now: number,
): SeqNote {
  const note: SeqNote = { lost: 0, firstLostKey: '', jump: null };
  const s = seqs[t];
  if (!s) {
    seqs[t] = { group, object, pending: new Map(), reorders: 0, lost: 0, settles: [] };
    return note;
  }
  const newer = group > s.group || (group === s.group && object > s.object);
  if (s.rebase && newer) {
    s.rebase = false;
    if (s.dropPending) s.pending.clear();
    s.dropPending = false;
    s.group = group;
    s.object = object;
    return note;
  }
  if (newer) {
    if (group - s.group > SEQ_JUMP_CAP) {
      s.pending.clear();
      note.jump = `${s.group}.${s.object} -> ${group}.${object}`;
    } else if (group === s.group) {
      for (let o = s.object + 1n; o < object; o++) s.pending.set(`${group}.${o}`, now);
    } else {
      // Only each skipped group's head is tracked: without END_OF_GROUP the
      // previous group's object count is unknown, so its tail is not a hole.
      for (let g = s.group + 1n; g < group; g++) s.pending.set(`${g}.0`, now);
      for (let o = 0n; o < object && o < SEQ_JUMP_CAP; o++) s.pending.set(`${group}.${o}`, now);
    }
    s.group = group;
    s.object = object;
  } else {
    const key = `${group}.${object}`;
    const at = s.pending.get(key);
    if (at !== undefined) {
      s.pending.delete(key);
      s.reorders++;
      s.settles.push([now, now - at]);
    }
  }
  while (s.settles.length && now - s.settles[0]![0] > SETTLE_WINDOW_MS) s.settles.shift();
  for (const [key, at] of s.pending) {
    if (now - at <= REORDER_SETTLE_MS) continue;
    s.pending.delete(key);
    if (!note.lost) note.firstLostKey = key;
    note.lost++;
  }
  s.lost += note.lost;
  return note;
}

// ── Stalls cell ────────────────────────────────────────────────────

export interface StallInputs {
  stallCount: number;
  /** Completed stalls. */
  stallDurationMs: number;
  /** A detected stall still in progress; 0 when none. */
  ongoingStallMs: number;
  /** MSE video holes played through; 0 on the LOC path. */
  freezes: number;
  frozenSec: number;
  locPath: boolean;
}

/** Value in seconds, fault count and tooltip detail of the stalls cell. */
export function stallsCell(i: StallInputs): { sec: number; faults: number; detail: string } {
  const stallSec = (i.stallDurationMs + i.ongoingStallMs) / 1000;
  const ongoing = i.ongoingStallMs > 0
    ? `, ongoing for ${(i.ongoingStallMs / 1000).toFixed(1)} s` : '';
  return {
    sec: stallSec + (i.locPath ? 0 : i.frozenSec),
    faults: i.stallCount + (i.locPath ? 0 : i.freezes),
    detail: `Stalls: ${i.stallCount} (${stallSec.toFixed(1)} s${ongoing})`
      + (i.locPath ? '' : ` · Freezes: ${i.freezes} (${i.frozenSec.toFixed(1)} s)`),
  };
}

// ── Picture frozen ─────────────────────────────────────────────────

/** A playhead that has not moved for this long while playing is frozen. */
export const PLAYHEAD_FROZEN_MS = 1_000;

export interface FreezeInputs {
  nowMs: number;
  /** The engine's stall in progress; 0 when none. */
  ongoingStallMs: number;
  /** MSE playhead (s), or null where there is none to watch (LOC, paused, hidden, before the first frame). */
  playheadSec: number | null;
  playbackRate: number;
  /** Start (s) of a video hole the playhead is inside: the picture holds while audio plays on. */
  holeStartSec: number | null;
}

/**
 * Tracks whether the picture is frozen and since when. Latency is measured
 * from arrivals, which go on during a freeze, so the page withholds it while
 * this reports a freeze.
 */
export class FreezeWatch {
  private lastPlayheadSec: number | null = null;
  private playheadMovedAtMs = 0;

  /** Wall time (performance.now()) the current freeze began, or null when the picture moves. */
  update(i: FreezeInputs): number | null {
    const since: number[] = [];
    if (i.ongoingStallMs > 0) since.push(i.nowMs - i.ongoingStallMs);
    if (i.playheadSec === null) {
      this.lastPlayheadSec = null;
    } else {
      if (this.lastPlayheadSec === null || i.playheadSec !== this.lastPlayheadSec) {
        this.lastPlayheadSec = i.playheadSec;
        this.playheadMovedAtMs = i.nowMs;
      } else if (i.nowMs - this.playheadMovedAtMs >= PLAYHEAD_FROZEN_MS) {
        since.push(this.playheadMovedAtMs);
      }
      if (i.holeStartSec !== null && i.playheadSec >= i.holeStartSec) {
        since.push(i.nowMs - ((i.playheadSec - i.holeStartSec) * 1000) / (i.playbackRate || 1));
      }
    }
    return since.length ? Math.min(...since) : null;
  }
}
