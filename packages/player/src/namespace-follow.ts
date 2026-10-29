/**
 * Following the played namespace with SUBSCRIBE_NAMESPACE (draft-18 §10.18, draft-22 §9.15):
 * reports whether the publisher is announcing it and, when it is published
 * again after going away, resumes on the current session, or re-establishes it.
 *
 * @module
 */

import type { ControlMessage } from '@openmoq/transport';
import type { MoqtConnection } from '@openmoq/webtransport';
import type { NamespaceState } from './events.js';

/**
 * What the host did about a return: resumed on the current session, left live
 * subscriptions to resume by themselves, or found the session needs replacing.
 */
export type ReturnAction = 'resumed' | 'settle' | 'reestablish';

export interface NamespaceFollowHost {
  /** The current session; messages from any other are stale. */
  connection(): MoqtConnection | null;
  /** The followed namespace, encoded. */
  namespace(): Uint8Array[];
  /** Microseconds, on the player's clock. */
  now(): number;
  onState(state: NamespaceState, detail: string): void;
  /** Whether the session may be re-established for a return at `returnedAtUs`
   *  (false once media resumed by itself). */
  canReestablish(returnedAtUs: number): boolean;
  reestablish(): void;
  /**
   * Resubscribe on the current session what cannot resume by itself: the
   * catalog when `catalogLost`, else ended media.
   */
  resumeInSession(catalogLost: boolean): ReturnAction;
  /** An in-session resume is parked until the page is visible. */
  resumeHeld(): boolean;
}

export class NamespaceFollower {
  /** How long media may take to resume by itself after the namespace returns. */
  static RETURN_SETTLE_MS = 2_000;
  /** Minimum spacing between re-establishes on the namespace's return. */
  static readonly RETURN_MIN_SPACING_US = 10_000_000;
  /**
   * How long an in-session resume may take to deliver media before the session
   * is re-established: SUBSCRIBE_OK plus a live join at the next group, which
   * may be a 2 s GOP away.
   */
  static RESUME_BOUND_MS = 3_000;
  /** Minimum spacing between in-session resumes; a closer return waits RETURN_SETTLE_MS instead. */
  static readonly RESUME_MIN_SPACING_US = 1_000_000;

  private requestId: bigint | null = null;
  /** The session being followed, set before SUBSCRIBE_NAMESPACE is sent. */
  private followed: MoqtConnection | null = null;
  private _state: NamespaceState | null = null;
  /** The namespace went away (withdrawn, or a track refused as not existing). */
  private lost = false;
  /** The catalog subscription failed before the first catalog. */
  private catalogLost = false;
  /** An in-session resume is awaiting media. */
  private resuming = false;
  private resumeAtUs = -Infinity;
  /** When the return being handled happened. */
  private returnedAtUs = -Infinity;
  private returnAtUs = -Infinity;
  private returnTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly host: NamespaceFollowHost) {}

  /** The followed namespace's state, or null when not following. */
  get state(): NamespaceState | null {
    return this._state;
  }

  /** SUBSCRIBE_NAMESPACE for the followed namespace on `conn`. */
  async follow(conn: MoqtConnection): Promise<void> {
    this.requestId = null;
    this.followed = conn;
    this.catalogLost = false;
    if (this.resuming) this.clearReturn();
    this.setState('pending', 'SUBSCRIBE_NAMESPACE sent');
    try {
      const reqId = await conn.subscribeNamespace(this.host.namespace());
      if (conn === this.host.connection()) this.requestId = BigInt(reqId);
    } catch (err) {
      if (conn !== this.host.connection()) return;
      this.followed = null;
      this.setState('refused',
        `SUBSCRIBE_NAMESPACE failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** A NAMESPACE or NAMESPACE_DONE on one of `conn`'s namespace streams. */
  onNamespaceMessage(
    conn: MoqtConnection, requestId: unknown, type: 'NAMESPACE' | 'NAMESPACE_DONE', suffix: readonly Uint8Array[],
  ): void {
    if (conn !== this.host.connection() || this.requestId === null) return;
    if (BigInt(requestId as bigint) !== this.requestId || suffix.length !== 0) return;
    if (type === 'NAMESPACE') this.setState('published', 'NAMESPACE: the publisher is announcing it');
    else this.setState('withdrawn', 'NAMESPACE_DONE: the publisher withdrew it');
  }

  /** The SUBSCRIBE_NAMESPACE's response on the current session; true when it was. */
  onResponse(msg: ControlMessage): boolean {
    if (this.requestId === null || !('requestId' in msg)) return false;
    if (BigInt((msg as { requestId: bigint | number }).requestId) !== this.requestId) return false;
    if (msg.type === 'REQUEST_OK' && this._state === 'pending') {
      this.setState('listening', 'SUBSCRIBE_NAMESPACE accepted');
      return true;
    }
    if (msg.type === 'REQUEST_ERROR') {
      const reason = (msg as { errorReason?: string }).errorReason ?? '';
      this.setState('refused', `SUBSCRIBE_NAMESPACE refused: ${reason}`);
      return true;
    }
    return false;
  }

  /**
   * A track was refused as not existing: unless published, the namespace's
   * publication resumes. Refusing an in-session resume re-establishes.
   */
  noteTrackMissing(): void {
    if (this._state !== 'published') this.lost = true;
    else if (this.resuming) this.resumeFailed();
  }

  /**
   * The catalog is unavailable before the first catalog: resume once the
   * namespace is published (now, if it already is); a failed in-session resume
   * re-establishes. False when not following on `conn`; the caller then
   * reports the failure.
   */
  awaitPublisher(conn: MoqtConnection): boolean {
    if (conn !== this.host.connection() || conn !== this.followed) return false;
    this.catalogLost = true;
    if (this._state !== 'published') {
      this.lost = true;
    } else if (this.resuming) {
      this.resumeFailed();
    } else {
      this.clearReturn();
      this.returned();
    }
    return true;
  }

  destroy(): void {
    this.clearReturn();
  }

  private setState(state: NamespaceState, detail: string): void {
    if (this._state === state) return;
    this._state = state;
    if (state === 'withdrawn') this.lost = true;
    this.host.onState(state, detail);
    if (state === 'published' && this.lost) this.returned();
  }

  /**
   * The namespace is published again after it went away. Resume on the current
   * session when nothing on it can resume by itself, re-establishing if no
   * media follows within RESUME_BOUND_MS; re-establish at once when the host
   * says so; otherwise re-establish if media has not resumed within
   * RETURN_SETTLE_MS. Re-establishes at most once per RETURN_MIN_SPACING_US.
   */
  private returned(): void {
    this.lost = false;
    if (this.returnTimer !== null) {
      // A pending return stands until media arrives after it.
      if (this.host.canReestablish(this.returnedAtUs)) return;
      this.clearReturn();
    }
    const now = this.host.now();
    this.returnedAtUs = now;
    const action = now - this.resumeAtUs >= NamespaceFollower.RESUME_MIN_SPACING_US
      ? this.host.resumeInSession(this.catalogLost) : 'settle';
    if (action === 'resumed') {
      this.catalogLost = false;
      this.resumeAtUs = now;
      this.resuming = true;
      this.arm(NamespaceFollower.RESUME_BOUND_MS);
      return;
    }
    this.arm(action === 'reestablish' ? 0 : NamespaceFollower.RETURN_SETTLE_MS);
  }

  private arm(delayMs: number): void {
    const returnedAtUs = this.returnedAtUs;
    this.returnTimer = setTimeout(() => {
      this.returnTimer = null;
      if (this.resuming && this.host.resumeHeld()) {
        this.arm(NamespaceFollower.RESUME_BOUND_MS);
        return;
      }
      this.resuming = false;
      this.reestablishIfStalled(returnedAtUs);
    }, delayMs);
  }

  /** Re-establish on the next tick, outside the refusal's handler. */
  private resumeFailed(): void {
    this.clearReturn();
    this.arm(0);
  }

  private reestablishIfStalled(returnedAtUs: number): void {
    if (!this.host.canReestablish(returnedAtUs)) return;
    const now = this.host.now();
    if (now - this.returnAtUs < NamespaceFollower.RETURN_MIN_SPACING_US) return;
    this.returnAtUs = now;
    this.host.reestablish();
  }

  private clearReturn(): void {
    if (this.returnTimer !== null) clearTimeout(this.returnTimer);
    this.returnTimer = null;
    this.resuming = false;
  }
}
