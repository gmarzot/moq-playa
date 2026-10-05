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
import { RequestError, RequestError18 } from '@moqt/transport';
import type { Fetch } from '@moqt/transport';
import { acceptCatalogSubscribe, buildCatalogPayload, publishCatalogGroup } from './catalog-publisher.js';
import type { BroadcastCatalogParams } from './catalog-publisher.js';
import { MediaPublisher } from './media-publisher.js';
import type { MediaPublishConnection, MediaPublisherOptions } from './media-publisher.js';

/** The subset of MoqtConnection a broadcast generation uses. */
export interface BroadcastSessionConnection extends MediaPublishConnection {
  acceptSubscribe(requestId: unknown, alias: unknown, options?: { parameters?: Map<bigint, unknown[]> }): Promise<void>;
  rejectSubscribe(requestId: unknown, errorCode: unknown, reason: string): Promise<void>;
  /** Terminal for a subscription accepted but not servable (catalog transaction). */
  publishDone(requestId: unknown, statusCode: unknown, reason: string): Promise<void>;
  close(): Promise<void>;
  acceptFetch(requestId: bigint, options?: { endLocation?: { group: bigint; object: bigint } }): Promise<void>;
  rejectFetch(requestId: bigint, errorCode: bigint, reason: string): Promise<void>;
  openFetchStream(requestId: bigint): Promise<bigint>;
  sendFetchObject(streamId: bigint, fields: {
    groupId: bigint; subgroupId: bigint; objectId: bigint; publisherPriority: number; payload: Uint8Array;
  }): Promise<void>;
  sendFetchEndOfRange(streamId: bigint, nonExistent: boolean, groupId: bigint, objectId: bigint): Promise<void>;
  closeFetchStream(streamId: bigint): Promise<void>;
  /** The standalone range of a Joining FETCH, from the Joining Location; throws without one. */
  resolveJoiningFetch(requestId: bigint): {
    startLocation: { group: bigint; object: bigint }; endLocation: { group: bigint; object: bigint };
  };
}

/** The priority a catalog subgroup inherits when it omits one (§12.4). */
const CATALOG_PRIORITY = 128;
/** FETCH parameter carrying the requested Group Order; 2 is Descending. */
const GROUP_ORDER_PARAM = 0x22n;
/** SUBSCRIBE_OK / REQUEST_UPDATE_OK parameter carrying the Largest Location (§10.2.11). */
const LARGEST_OBJECT_PARAM = 0x09n;
/** PUBLISH_DONE TRACK_ENDED, "the track is no longer being published" (§10.11);
 *  0x2 in the draft-18 and the draft-14/16 tables alike. */
const TRACK_ENDED = 0x2n;
const END_SUBSCRIPTIONS_MS = 500;

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
  /** Catalog re-emission period, a cache refresh only (MSF-01 §5): late
   *  viewers get the latest catalog by FETCH. Default 0, disabled. */
  catalogIntervalMs?: number;
  /** Each successful re-emission, for a verbose UI. Not called for the first
   *  catalog, which reports through onCatalogPublished. */
  onCatalogReemitted?: (bytes: number) => void;
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

/** A track's MoQT subscription as the broadcaster serves it. */
export type TrackStatus =
  | {
    readonly state: 'none';
    /** Why the last subscription for the track ended, if one did. */
    readonly ended?: string;
  }
  | {
    readonly state: 'live';
    readonly requestId: bigint;
    readonly alias: bigint;
    /** Forward State (§5.1). */
    readonly forward: boolean;
    /** Accepted, but the publisher has retired the track: nothing is produced. */
    readonly fault: boolean;
  };

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
  private catalogAlias: bigint | null = null;
  /** Last catalog group ID issued, and the current one: its Object 0 is the catalog. */
  private catalogGroupIssued: bigint | null = null;
  private catalogGroup: bigint | null = null;
  /** The track each accepted SUBSCRIBE serves, by request ID. */
  private readonly subscribedTrack = new Map<bigint, string>();
  /** The request currently served for each track. */
  private readonly currentRequest = new Map<string, bigint>();
  /** Per accepted request: its alias and Forward State. */
  private readonly aliasOf = new Map<bigint, bigint>();
  private readonly forwardOf = new Map<bigint, boolean>();
  /** Per track: why its last subscription ended. */
  private readonly endedReason = new Map<string, string>();
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
    // Draft-18: the catalog exists from the start; SUBSCRIBE_OK reports it and FETCH serves it.
    if (opts.publisher.draft === 18) this.catalogGroup = this.nextCatalogGroup();
  }

  /** A track carries one alias, so a second concurrent subscription would be
   *  served only the newest. */
  private warnOnAliasReplace(track: string, armed: bigint | null, next: bigint): void {
    if (armed === null || armed === next) return;
    this.safeLog(`WARNING: ${track} alias ${armed} replaced by ${next} — this publisher `
      + `serves ONE subscription per track; the earlier one now receives nothing`);
  }

  /** Wall-clock group IDs, kept strictly increasing. */
  private nextCatalogGroup(): bigint {
    const now = BigInt(Date.now());
    const last = this.catalogGroupIssued;
    this.catalogGroupIssued = last !== null && now <= last ? last + 1n : now;
    return this.catalogGroupIssued;
  }

  private noteCatalogGroup(group: bigint): void {
    if (this.catalogGroup === null || group > this.catalogGroup) this.catalogGroup = group;
  }

  /**
   * Re-publish the catalog on an interval, as a cache refresh. Late viewers
   * reach the latest group by FETCH ({@link handleFetch}). Best-effort: a
   * failed re-emission is reported once and the interval continues.
   */
  private startCatalogReemission(alias: bigint): void {
    // A new catalog subscription has its own alias; the old one is gone.
    this.stopCatalogReemission();
    this.catalogAlias = alias;
    const periodMs = this.opts.catalogIntervalMs ?? 0;
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
      const groupId = this.nextCatalogGroup();
      void publishCatalogGroup(
        this.connection as never, alias, payload, { draft: this.opts.publisher.draft, groupId },
      ).then(() => {
        this.noteCatalogGroup(groupId);
        if (!this.retired) this.opts.onCatalogReemitted?.(payload.byteLength);
      }).catch((err: unknown) => {
        if (reportedFailure) return;
        reportedFailure = true;
        this.safeLog(`Catalog re-emission failed: ${(err as Error)?.message ?? err}`);
      });
    }, periodMs);
  }

  /** Stop before the connection goes away. */
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
    this.safeLog(`${trackName}: SUBSCRIBE (reqId=${requestId}, alias=${alias})`);
    const served = trackName === 'catalog' || trackName === 'video'
      || (trackName === 'audio' && !!this.opts.catalog.audio);
    const report = (err: unknown) => {
      // The relay cancelled it (logged by handleSubscribeClosed); the failure follows from that.
      if (served && !this.subscribedTrack.has(requestId)) return;
      this.safeLog(`Failed to serve "${trackName}" subscription: ${(err as Error)?.message ?? err}`);
    };
    if (served) {
      this.subscribedTrack.set(requestId, trackName);
      this.currentRequest.set(trackName, requestId);
    }

    if (trackName === 'catalog' && this.opts.publisher.draft === 18) {
      this.acceptCatalogAtLargest(requestId, alias, report);
    } else if (trackName === 'catalog') {
      // Catalog publication is SESSION-OWNED work: tracked so shutdown()
      // accounts for it; the retired-guard keeps a stale completion from
      // touching a replacement generation's UI.
      const groupId = this.nextCatalogGroup();
      const work = acceptCatalogSubscribe(
        this.connection as never, requestId, alias, this.opts.catalog,
        { draft: this.opts.publisher.draft, groupId })
        .then((bytes) => {
          this.noteCatalogGroup(groupId);
          this.safeLog(`Catalog published (${bytes} bytes)`);
          this.noteAccepted(requestId, alias);
          if (!this.retired) {
            this.opts.onCatalogPublished?.(bytes);
            this.startCatalogReemission(alias);
          }
        })
        .catch(report);
      this.trackWork(work);
    } else if (trackName === 'video') {
      this.connection.acceptSubscribe(
        this.wrapInt(requestId), this.wrapInt(alias),
        this.subscribeOkOptions(this.publisher.largestLocation('video')))
        .then(() => {
          if (this.retired) return; // never arm a retired generation's publisher
          this.warnOnAliasReplace('video', this.publisher.videoAliasArmed, alias);
          this.noteAccepted(requestId, alias);
          this.publisher.setVideoAlias(alias);
          this.safeLog('video: SUBSCRIBE_OK');
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
      this.connection.acceptSubscribe(
        this.wrapInt(requestId), this.wrapInt(alias),
        this.subscribeOkOptions(this.publisher.largestLocation('audio')))
        .then(() => {
          if (this.retired) return;
          this.warnOnAliasReplace('audio', this.publisher.audioAliasArmed, alias);
          this.noteAccepted(requestId, alias);
          this.publisher.setAudioAlias(alias);
          this.safeLog('audio: SUBSCRIBE_OK');
        })
        .catch(report);
    } else {
      this.connection.rejectSubscribe(this.wrapInt(requestId), this.wrapInt(0n), `Unknown track: ${trackName}`)
        .catch(report);
    }
  }

  /**
   * Draft-18 catalog SUBSCRIBE: accept with the current catalog as the Largest
   * Location (§10.2.11). Nothing is sent on the subscription; viewers retrieve
   * the catalog with a Joining FETCH (MSF-01 §5).
   */
  private acceptCatalogAtLargest(requestId: bigint, alias: bigint, report: (err: unknown) => void): void {
    let bytes: number;
    try {
      bytes = buildCatalogPayload(this.opts.catalog).byteLength;
    } catch (err) {
      report(err);
      this.connection.rejectSubscribe(this.wrapInt(requestId), this.wrapInt(0n), 'catalog build failed')
        .catch(report);
      return;
    }
    const largest = { group: this.catalogGroup!, object: 0n };
    const work = this.connection.acceptSubscribe(
      this.wrapInt(requestId), this.wrapInt(alias), this.subscribeOkOptions(largest))
      .then(() => {
        this.safeLog(`catalog: SUBSCRIBE_OK (Largest ${largest.group}/0, served by FETCH)`);
        this.noteAccepted(requestId, alias);
        if (!this.retired) {
          this.opts.onCatalogPublished?.(bytes);
          this.startCatalogReemission(alias);
        }
      })
      .catch(report);
    this.trackWork(work);
  }

  /** Draft-18 SUBSCRIBE_OK carries LARGEST_OBJECT once the track has objects (§10.2.11). */
  private subscribeOkOptions(
    largest: { group: bigint; object: bigint } | null,
  ): { parameters: Map<bigint, unknown[]> } | undefined {
    if (this.opts.publisher.draft !== 18 || largest === null) return undefined;
    return { parameters: new Map([[LARGEST_OBJECT_PARAM, [largest]]]) };
  }

  /**
   * Answer an inbound FETCH with exactly one FETCH_OK or REQUEST_ERROR (§5.2).
   * Only the catalog is served, from its current group: MSF-01 §5 viewers join
   * with a Joining FETCH, which a relay serves from cache or forwards. A
   * superseded group is not retained (MSF-01 §5 has viewers ignore it).
   */
  handleFetch(requestId: bigint, fetch: Fetch): void {
    if (this.retired) {
      this.safeLog(`Ignoring FETCH reqId=${requestId} on a retired broadcast session`);
      return;
    }
    const reject = (code: bigint, reason: string): void => {
      this.safeLog(`FETCH reqId=${requestId}: REQUEST_ERROR (${reason})`);
      this.connection.rejectFetch(requestId, code, reason).catch((err: unknown) => {
        this.safeLog(`FETCH reqId=${requestId}: REQUEST_ERROR not sent: ${(err as Error)?.message ?? err}`);
      });
    };
    // FETCH response streams are draft-18 only in this adapter.
    if (this.opts.publisher.draft !== 18) {
      reject(RequestError.NOT_SUPPORTED, 'FETCH is served on draft-18 only');
      return;
    }
    const f = fetch.fetch;
    const trackName = f.fetchType === 0x1
      ? new TextDecoder().decode(f.trackName)
      : this.subscribedTrack.get(f.joiningRequestId as bigint) ?? 'catalog';
    if (trackName !== 'catalog') {
      const known = trackName === 'video' || (trackName === 'audio' && !!this.opts.catalog.audio);
      reject(known ? RequestError18.NOT_SUPPORTED : RequestError18.DOES_NOT_EXIST,
        `FETCH of "${trackName}" is not served`);
      return;
    }
    let range: { startLocation: { group: bigint; object: bigint }; endLocation: { group: bigint; object: bigint } };
    if (f.fetchType === 0x1) {
      range = { startLocation: f.startLocation, endLocation: f.endLocation };
    } else {
      try {
        range = this.connection.resolveJoiningFetch(requestId);
      } catch (err) {
        reject(RequestError18.INVALID_RANGE, `no Joining Location: ${(err as Error)?.message ?? err}`);
        return;
      }
    }
    const g = this.catalogGroup!;
    const start = range.startLocation;
    if (start.group > g || (start.group === g && start.object > 0n)) {
      reject(RequestError18.INVALID_RANGE, 'start is past the current catalog');
      return;
    }
    // End is exclusive, and Object 0 means the whole End group: {g,0} is inside iff g <= end.group.
    if (range.endLocation.group < g) {
      reject(RequestError18.INVALID_RANGE, 'only the current catalog group is retained');
      return;
    }
    let payload: Uint8Array;
    try {
      payload = buildCatalogPayload(this.opts.catalog);
    } catch (err) {
      reject(RequestError18.INTERNAL_ERROR, `catalog build failed: ${(err as Error)?.message ?? err}`);
      return;
    }
    const descending = fetch.parameters.get(GROUP_ORDER_PARAM)?.[0] === 2n;
    // Earlier groups are not retained: their range is marked unknown (§11.4.4.2).
    // Our catalog groups hold Object 0 alone, so a start inside group g-1 needs no marker.
    const earlier = start.group < g - 1n || (start.group === g - 1n && start.object === 0n);
    const work = (async () => {
      await this.connection.acceptFetch(requestId, { endLocation: { group: g, object: 1n } });
      const streamId = await this.connection.openFetchStream(requestId);
      if (earlier && !descending) await this.connection.sendFetchEndOfRange(streamId, false, g - 1n, 0n);
      await this.connection.sendFetchObject(streamId, {
        groupId: g, subgroupId: 0n, objectId: 0n, publisherPriority: CATALOG_PRIORITY, payload,
      });
      if (earlier && descending) {
        await this.connection.sendFetchEndOfRange(streamId, false, start.group, start.object);
      }
      await this.connection.closeFetchStream(streamId);
      this.safeLog(`catalog: FETCH served (reqId=${requestId}, group ${g})`);
    })().catch((err: unknown) => {
      this.safeLog(`catalog: FETCH reqId=${requestId} failed: ${(err as Error)?.message ?? err}`);
    });
    this.trackWork(work);
  }

  /**
   * End every accepted subscription with PUBLISH_DONE TRACK_ENDED (§10.11):
   * production stops first, then the terminals go out, bounded together. A
   * relay passes them on to its viewers and drops its upstream state, so a
   * later broadcast under the same namespace starts clean.
   */
  async endSubscriptions(timeoutMs = END_SUBSCRIPTIONS_MS): Promise<void> {
    if (this.retired) return;
    this.stopCatalogReemission();
    const ends: Array<Promise<unknown>> = [];
    for (const [track, requestId] of [...this.currentRequest]) {
      this.currentRequest.delete(track);
      this.subscribedTrack.delete(requestId);
      const accepted = this.aliasOf.delete(requestId);
      this.forwardOf.delete(requestId);
      if (track === 'video' || track === 'audio') this.publisher.endTrack(track);
      if (track === 'catalog') this.catalogAlias = null;
      if (!accepted) continue;
      this.endedReason.set(track, `PUBLISH_DONE TRACK_ENDED reqId=${requestId}`);
      ends.push(this.connection.publishDone(
        this.wrapInt(requestId), this.wrapInt(TRACK_ENDED), 'broadcast stopped',
      ).catch(() => {}));
    }
    if (ends.length === 0) return;
    this.safeLog(`PUBLISH_DONE TRACK_ENDED on ${ends.length} subscription(s)`);
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      Promise.all(ends),
      new Promise<void>((resolve) => { timer = setTimeout(resolve, timeoutMs); }),
    ]);
    clearTimeout(timer);
  }

  /**
   * The relay ended a subscription, as it does upstream once its last viewer
   * leaves. The namespace stays published: the track idles until a new
   * SUBSCRIBE. A close for a request a newer SUBSCRIBE already replaced
   * changes nothing.
   */
  handleSubscribeClosed(requestId: bigint): void {
    if (this.retired) return;
    const track = this.subscribedTrack.get(requestId);
    if (track === undefined) return;
    this.subscribedTrack.delete(requestId);
    this.aliasOf.delete(requestId);
    this.forwardOf.delete(requestId);
    this.safeLog(`${track}: SUBSCRIBE cancelled by the relay (reqId=${requestId})`);
    if (this.currentRequest.get(track) !== requestId) return;
    this.currentRequest.delete(track);
    this.endedReason.set(track, `relay cancelled SUBSCRIBE reqId=${requestId}`);
    if (track === 'catalog') {
      this.stopCatalogReemission();
      this.catalogAlias = null;
    } else if (track === 'video' || track === 'audio') {
      this.publisher.endTrack(track);
    }
  }

  /**
   * The relay changed a subscription's Forward State (§5.1), as it does when
   * its viewers pause or return. Media pauses and resumes in the publisher;
   * the catalog holds re-emission. On a draft-18 resume the REQUEST_UPDATE_OK
   * reports the current catalog; earlier drafts send it again.
   */
  handleForwardChange(requestId: bigint, forward: boolean): void {
    if (this.retired) return;
    const track = this.subscribedTrack.get(requestId);
    if (track === undefined || this.currentRequest.get(track) !== requestId) return;
    if (this.forwardOf.has(requestId)) this.forwardOf.set(requestId, forward);
    this.safeLog(`${track}: Forward State ${forward ? 1 : 0} (REQUEST_UPDATE, reqId=${requestId})`);
    if (track === 'video' || track === 'audio') {
      this.publisher.setForward(track, forward);
    } else if (!forward) {
      this.stopCatalogReemission();
    } else if (this.catalogAlias !== null) {
      if (this.opts.publisher.draft === 18) this.startCatalogReemission(this.catalogAlias);
      else this.resendCatalog(this.catalogAlias);
    }
  }

  /** Largest Location for a subscription, which a draft-18 resume must report. */
  largestLocation(requestId: bigint): { group: bigint; object: bigint } | null {
    const track = this.subscribedTrack.get(requestId);
    if (track === 'video' || track === 'audio') return this.publisher.largestLocation(track);
    return track === 'catalog' && this.opts.publisher.draft === 18
      ? { group: this.catalogGroup!, object: 0n } : null;
  }

  /** Send the catalog now, then resume re-emitting it on `alias`. */
  private resendCatalog(alias: bigint): void {
    let payload: Uint8Array;
    try {
      payload = buildCatalogPayload(this.opts.catalog);
    } catch {
      return; // the first publish already proved the params build
    }
    const groupId = this.nextCatalogGroup();
    const work = publishCatalogGroup(
      this.connection as never, alias, payload, { draft: this.opts.publisher.draft, groupId },
    ).then(() => {
      this.noteCatalogGroup(groupId);
      if (!this.retired && this.catalogAlias === alias) this.startCatalogReemission(alias);
    }).catch((err: unknown) => {
      this.safeLog(`Catalog resend failed: ${(err as Error)?.message ?? err}`);
    });
    this.trackWork(work);
  }

  /** The track's current subscription, or why there is none. A closed
   *  session serves nothing. */
  trackStatus(track: 'catalog' | 'video' | 'audio'): TrackStatus {
    const requestId = this.retired ? undefined : this.currentRequest.get(track);
    const alias = requestId === undefined ? undefined : this.aliasOf.get(requestId);
    if (requestId === undefined || alias === undefined) {
      const ended = this.retired ? 'session closed' : this.endedReason.get(track);
      return ended === undefined ? { state: 'none' } : { state: 'none', ended };
    }
    return {
      state: 'live',
      requestId,
      alias,
      forward: this.forwardOf.get(requestId) ?? true,
      fault: track !== 'catalog' && this.publisher.endedTracks.includes(track),
    };
  }

  /** The subscription is accepted and served from now on. */
  private noteAccepted(requestId: bigint, alias: bigint): void {
    if (this.subscribedTrack.get(requestId) === undefined) return; // closed meanwhile
    this.aliasOf.set(requestId, alias);
    this.forwardOf.set(requestId, true);
    this.endedReason.delete(this.subscribedTrack.get(requestId)!);
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
