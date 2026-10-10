/**
 * Following the played namespace with SUBSCRIBE_NAMESPACE (draft-18 §10.18):
 * reports whether the publisher is announcing it and, when it is published
 * again after going away, asks the player to re-establish the session.
 *
 * @module
 */

import type { ControlMessage } from '@openmoq/transport';
import type { MoqtConnection } from '@openmoq/webtransport';
import type { NamespaceState } from './events.js';

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
}

export class NamespaceFollower {
  /** How long media may take to resume by itself after the namespace returns. */
  static RETURN_SETTLE_MS = 2_000;
  /** Minimum spacing between re-establishes on the namespace's return. */
  static readonly RETURN_MIN_SPACING_US = 10_000_000;

  private requestId: bigint | null = null;
  private _state: NamespaceState | null = null;
  /** The namespace went away (withdrawn, or a track refused as not existing). */
  private lost = false;
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
    this.setState('pending', 'SUBSCRIBE_NAMESPACE sent');
    try {
      const reqId = await conn.subscribeNamespace(this.host.namespace());
      if (conn === this.host.connection()) this.requestId = BigInt(reqId);
    } catch (err) {
      if (conn !== this.host.connection()) return;
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

  /** A track was refused as not existing: unless published, the namespace's publication re-establishes. */
  noteTrackMissing(): void {
    if (this._state !== 'published') this.lost = true;
  }

  /**
   * The catalog is unavailable before the first catalog: re-establish once the
   * namespace is published (now, if it already is). False when not following
   * on `conn`; the caller then reports the failure.
   */
  awaitPublisher(conn: MoqtConnection): boolean {
    if (conn !== this.host.connection() || this.requestId === null) return false;
    if (this._state === 'published') this.returned();
    else this.lost = true;
    return true;
  }

  destroy(): void {
    if (this.returnTimer !== null) clearTimeout(this.returnTimer);
    this.returnTimer = null;
  }

  private setState(state: NamespaceState, detail: string): void {
    if (this._state === state) return;
    this._state = state;
    if (state === 'withdrawn') this.lost = true;
    this.host.onState(state, detail);
    if (state === 'published' && this.lost) this.returned();
  }

  /**
   * The namespace is published again after it went away. If media has not
   * resumed by itself within RETURN_SETTLE_MS, re-establish the session — at
   * most once per RETURN_MIN_SPACING_US.
   */
  private returned(): void {
    this.lost = false;
    if (this.returnTimer !== null) return;
    const returnedAtUs = this.host.now();
    this.returnTimer = setTimeout(() => {
      this.returnTimer = null;
      if (!this.host.canReestablish(returnedAtUs)) return;
      const now = this.host.now();
      if (now - this.returnAtUs < NamespaceFollower.RETURN_MIN_SPACING_US) return;
      this.returnAtUs = now;
      this.host.reestablish();
    }, NamespaceFollower.RETURN_SETTLE_MS);
  }
}
