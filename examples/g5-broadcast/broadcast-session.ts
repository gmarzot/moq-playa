/**
 * One broadcast generation, session-local and DOM-free.
 *
 * Everything a broadcast touches — the connection, the media publisher, and
 * the alias allocator — is captured HERE at construction, never read from a
 * mutable global. Lifecycle callbacks are identity-guarded: once a
 * generation is retired (stop, or replacement by a new broadcast), a
 * delayed `onSubscribe` from its session can no longer accept
 * subscriptions or consume aliases, and a delayed `onClose` can no longer
 * stop or mutate the replacement generation.
 */
import { acceptCatalogSubscribe, buildCatalogPayload, publishCatalogGroup } from './catalog-publisher.js';
import type { BroadcastCatalogParams } from './catalog-publisher.js';
import { MediaPublisher } from './media-publisher.js';
import type { MediaPublishConnection, MediaPublisherOptions } from './media-publisher.js';

/** The subset of MoqtConnection a broadcast generation uses. */
export interface BroadcastSessionConnection extends MediaPublishConnection {
  acceptSubscribe(requestId: unknown, alias: unknown): Promise<void>;
  rejectSubscribe(requestId: unknown, errorCode: unknown, reason: string): Promise<void>;
  /** Terminal for a subscription accepted but not servable (catalog transaction). */
  publishDone(requestId: unknown, statusCode: unknown, reason: string): Promise<void>;
  close(): Promise<void>;
}

export interface BroadcastSessionOptions {
  catalog: BroadcastCatalogParams;
  /** MediaPublisher options; `draft` (the negotiated draft) also selects the
   *  catalog subgroup's wire flags. */
  publisher: MediaPublisherOptions;
  log: (message: string) => void;
  /** Grace window for a normal shutdown drain before the connection is
   *  hard-closed (which unblocks any permanently stalled write). */
  shutdownGraceMs?: number;
  /** The catalog went out — the broadcast is live (UI hook). */
  onCatalogPublished?: (bytes: number) => void;
  /** Catalog re-emission period (default 1000ms). 0 disables it. */
  catalogIntervalMs?: number;
  /** THIS generation's session closed while it was still current (UI hook).
   *  Never invoked for a retired generation — a superseded session must not
   *  stop its replacement. */
  onSessionClosed?: (error?: number, reason?: string) => void;
}

const DEFAULT_SHUTDOWN_GRACE_MS = 2000;
/** Bound on the connection close itself — a close() that never settles must
 *  not wedge the shutdown either. */
const CLOSE_DEADLINE_MS = 1000;
/** Final window granted to publication work after the close, which SHOULD
 *  have rejected any held write. If it did not, the work is ABANDONED
 *  (it never rejects, so abandoning it surfaces nothing). */
const POST_CLOSE_DEADLINE_MS = 250;

export class BroadcastSession {
  readonly publisher: MediaPublisher;
  private readonly connection: BroadcastSessionConnection;
  private readonly opts: BroadcastSessionOptions;
  private readonly wrapInt: (n: bigint) => unknown;
  /** Per-generation alias space — a restart starts a fresh allocator. */
  private nextAlias = 1n;
  private retired = false;
  /** Re-emission timer for the catalog track, and the alias it publishes on. */
  private catalogTimer: ReturnType<typeof setInterval> | null = null;
  /** Session-owned in-flight work (catalog publication) that shutdown()
   *  must account for. */
  private readonly pendingWork = new Set<Promise<void>>();
  /** Single-flight shutdown. */
  private shutdownPromise: Promise<void> | null = null;

  constructor(connection: BroadcastSessionConnection, opts: BroadcastSessionOptions) {
    // Validate before anything is constructed or any wire work can start.
    if (opts.shutdownGraceMs !== undefined) {
      assertPositiveFinite(opts.shutdownGraceMs, 'shutdownGraceMs');
    }
    this.connection = connection;
    this.opts = opts;
    this.wrapInt = opts.publisher.wrapInt;
    this.publisher = new MediaPublisher(connection, opts.publisher);
  }

  /**
   * A track carries ONE alias, so a second concurrent subscription to it is
   * silently served only the newest. Name it: the publisher cannot fan out,
   * and this is the only place the condition is visible.
   */
  private warnOnAliasReplace(track: string, armed: bigint | null, next: bigint): void {
    if (armed === null || armed === next) return;
    this.safeLog(`WARNING: ${track} alias ${armed} replaced by ${next} — this publisher `
      + `serves ONE subscription per track; the earlier one now receives nothing`);
  }

  /**
   * Re-publish the catalog on an interval.
   *
   * MSF-01 §5 has a late joiner acquire the catalog by SUBSCRIBE plus a
   * joining FETCH, which needs no re-emission — but this publisher answers no
   * FETCH, and a relay subscribes upstream once and fans out, so without this
   * the catalog's single group is closed before any later viewer arrives and
   * they never acquire one. Best-effort: a failed re-emission is reported and
   * the interval continues, since the live subscription is still healthy.
   */
  private startCatalogReemission(alias: bigint): void {
    if (this.catalogTimer !== null) return;
    const periodMs = this.opts.catalogIntervalMs ?? 1_000;
    if (periodMs <= 0) return;
    let reportedFailure = false;
    this.catalogTimer = setInterval(() => {
      if (this.retired) return;
      let payload: Uint8Array;
      try {
        payload = buildCatalogPayload(this.opts.catalog);
      } catch {
        return; // the first publish already proved the params build
      }
      void publishCatalogGroup(
        this.connection as never, alias, payload, { draft: this.opts.publisher.draft },
      ).catch((err: unknown) => {
        if (reportedFailure) return;
        reportedFailure = true;
        this.safeLog(`Catalog re-emission failed: ${(err as Error)?.message ?? err}`
          + ' — later viewers may not acquire a catalog');
      });
    }, periodMs);
  }

  /** A timer outliving the session would publish into a dead connection. */
  private stopCatalogReemission(): void {
    if (this.catalogTimer === null) return;
    clearInterval(this.catalogTimer);
    this.catalogTimer = null;
  }

  /**
   * Serve an incoming SUBSCRIBE on THIS generation's connection. Synchronous
   * and void (the connection does not await its onSubscribe callback); every
   * async operation contains its own failure. Inert once retired.
   */
  handleSubscribe(requestId: bigint, trackName: string): void {
    if (this.retired) {
      this.safeLog(`Ignoring SUBSCRIBE for "${trackName}" on a retired broadcast session`);
      return;
    }
    const alias = this.nextAlias++;
    this.safeLog(`Relay subscribed to "${trackName}" (reqId=${requestId}, alias=${alias})`);
    const report = (err: unknown) => {
      this.safeLog(`Failed to serve "${trackName}" subscription: ${(err as Error)?.message ?? err}`);
    };

    if (trackName === 'catalog') {
      // Catalog publication is SESSION-OWNED work: tracked so shutdown()
      // accounts for it; the retired-guard keeps a stale completion from
      // touching a replacement generation's UI.
      const work = acceptCatalogSubscribe(
        this.connection as never, requestId, alias, this.opts.catalog, { draft: this.opts.publisher.draft })
        .then((bytes) => {
          this.safeLog(`Catalog published (${bytes} bytes)`);
          if (!this.retired) {
            this.opts.onCatalogPublished?.(bytes);
            this.startCatalogReemission(alias);
          }
        })
        .catch(report);
      this.trackWork(work);
    } else if (trackName === 'video') {
      this.connection.acceptSubscribe(this.wrapInt(requestId), this.wrapInt(alias))
        .then(() => {
          if (this.retired) return; // never arm a retired generation's publisher
          this.warnOnAliasReplace('video', this.publisher.videoAliasArmed, alias);
          this.publisher.setVideoAlias(alias);
          this.safeLog(`Accepted video subscription`);
        })
        .catch(report);
    } else if (trackName === 'audio') {
      if (!this.opts.catalog.audio) {
        // The capture has no audio track — the catalog does not advertise
        // one, and a subscription for it cannot ever be served.
        this.connection.rejectSubscribe(this.wrapInt(requestId), this.wrapInt(0n), 'No audio in this broadcast')
          .catch(report);
        return;
      }
      this.connection.acceptSubscribe(this.wrapInt(requestId), this.wrapInt(alias))
        .then(() => {
          if (this.retired) return;
          this.warnOnAliasReplace('audio', this.publisher.audioAliasArmed, alias);
          this.publisher.setAudioAlias(alias);
          this.safeLog(`Accepted audio subscription`);
        })
        .catch(report);
    } else {
      this.connection.rejectSubscribe(this.wrapInt(requestId), this.wrapInt(0n), `Unknown track: ${trackName}`)
        .catch(report);
    }
  }

  /**
   * THIS generation's session closed. One-shot and identity-guarded: a
   * retired (stopped or superseded) generation's close is inert.
   */
  handleClose(error?: number, reason?: string): void {
    if (this.retired) return;
    this.retired = true;
    this.stopCatalogReemission();
    this.publisher.retire();
    this.opts.onSessionClosed?.(error, reason);
  }

  /**
   * Tear this generation down: single-flight, graceful with a deadline.
   *
   * 1. Retire synchronously — callbacks and enqueues become inert.
   * 2. GRACEFUL: attempt to drain in-flight publication (including the
   *    session-owned catalog work) and FIN the active subgroup, bounded by
   *    the grace window.
   * 3. Close the connection. On the graceful path this happens AFTER the
   *    final subgroup FIN; on deadline expiry the close is what unblocks a
   *    permanently stalled write.
   * 4. Await the (now unblocked) cleanup. Never rejects.
   */
  shutdown(): Promise<void> {
    this.shutdownPromise ??= this.runShutdown();
    return this.shutdownPromise;
  }

  /** A throwing application logger must never break a protocol path. */
  private safeLog(message: string): void {
    try { this.opts.log(message); } catch { /* contained */ }
  }

  private trackWork(work: Promise<void>): void {
    // Store a CONTAINED view: a rejecting work item must not reject the
    // shutdown drain, and must not surface as an unhandled rejection.
    const contained = work.then(() => {}, () => {});
    this.pendingWork.add(contained);
    void contained.then(() => this.pendingWork.delete(contained));
  }

  /** Resolve true if `p` settles within `ms`, false on timeout. `p` must never
   *  reject (callers pass contained promises). */
  private async settledWithin(p: Promise<void>, ms: number): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const result = await Promise.race([
      p.then(() => true),
      new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), ms); }),
    ]);
    clearTimeout(timer);
    return result;
  }

  private async runShutdown(): Promise<void> {
    this.retired = true;
    this.stopCatalogReemission();
    this.publisher.retire();

    // Every stage below is CONTAINED and BOUNDED: shutdown resolves even if
    // the drain, the logger, a tracked work item, or close() itself misbehaves.
    const graceful = Promise.all([
      this.publisher.drain().then(() => {}, () => {}),
      ...this.pendingWork,
    ]).then(() => {}, () => {});

    const graceMs = this.opts.shutdownGraceMs ?? DEFAULT_SHUTDOWN_GRACE_MS;
    if (!await this.settledWithin(graceful, graceMs)) {
      this.safeLog(`Shutdown drain exceeded ${graceMs}ms — hard-closing the connection`);
    }

    // The close is GUARANTEED to be attempted, and bounded in its own right.
    const closed = this.connection.close().then(() => {}, () => {});
    if (!await this.settledWithin(closed, CLOSE_DEADLINE_MS)) {
      this.safeLog(`Connection close exceeded ${CLOSE_DEADLINE_MS}ms — abandoning it`);
    }

    // Closing SHOULD reject any write the grace window could not settle. If it
    // does not (a close() that resolves while a write stays pending), the work
    // is abandoned rather than awaited forever — it never rejects, so an
    // abandoned promise cannot surface as an unhandled rejection.
    if (!await this.settledWithin(graceful, POST_CLOSE_DEADLINE_MS)) {
      this.safeLog('Publication drain still pending after close — abandoned');
    }
  }
}

/** Validate a duration/bound option before any wire work can depend on it. */
function assertPositiveFinite(value: number, name: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive finite number of milliseconds, got ${value}`);
  }
}
