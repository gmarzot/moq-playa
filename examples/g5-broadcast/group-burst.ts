/**
 * Group-burst publication (`?groupBurst=1`): every Object of a video group, and
 * the audio published meanwhile, is held and sent back-to-back when the next
 * video group starts, like a publisher that emits whole segments at once.
 *
 * The hold sits between the publisher and its connection: calls resolve at
 * once with stand-in stream IDs, and {@link GroupBurstConnection.flush} replays
 * them, in order on each stream and on each track's datagrams, the streams
 * concurrently as the publisher would send them. A send failure there is
 * reported, not returned to the publisher, so the hold hides Forward State 0
 * refusals.
 */
import type { MediaPublishConnection } from './media-publisher.js';

export interface GroupBurstOptions {
  /** Held payload bytes above which the rest of the group goes out unheld (default 8 MiB). */
  maxBytes?: number;
  onError?: (context: string, err: unknown) => void;
  onLog?: (message: string) => void;
}

export const GROUP_BURST_MAX_BYTES = 8 * 1024 * 1024;

/** `lane`: ops on one lane replay in order; lanes run concurrently. */
type Op = { bytes: number; lane: string; run: () => Promise<void> };

export class GroupBurstConnection implements MediaPublishConnection {
  private readonly inner: MediaPublishConnection;
  private readonly maxBytes: number;
  private readonly onError: (context: string, err: unknown) => void;
  private readonly onLog: (message: string) => void;
  private held: Op[] = [];
  private heldBytes = 0;
  /** The cap was hit: ops run as they come until the next flush. */
  private passthrough = false;
  private closed = false;
  private chain: Promise<void> = Promise.resolve();
  /** Each lane's last replayed op. */
  private readonly lanes = new Map<string, Promise<void>>();
  /** Stand-in stream ID (negative) → the real one, once opened. */
  private readonly streams = new Map<bigint, bigint>();
  private nextStandIn = -1n;
  /** Flushes run, and groups whose hold was dropped at the cap. */
  readonly counts = { flushes: 0, capped: 0, failures: 0 };

  constructor(inner: MediaPublishConnection, options: GroupBurstOptions = {}) {
    this.inner = inner;
    this.maxBytes = options.maxBytes ?? GROUP_BURST_MAX_BYTES;
    this.onError = options.onError ?? (() => {});
    this.onLog = options.onLog ?? (() => {});
  }

  sendDatagram(
    trackAlias: bigint, groupId: bigint, objectId: bigint, payload: Uint8Array,
    opts?: { publisherPriority?: number; extensions?: Uint8Array },
  ): Promise<void> {
    if (!this.inner.sendDatagram) return Promise.reject(new Error('datagrams not supported'));
    return this.hold(payload.byteLength, `d${trackAlias}`,
      () => this.inner.sendDatagram!(trackAlias, groupId, objectId, payload, opts));
  }

  openSubgroup(alias: unknown, groupId: unknown, subgroupId: unknown, options: Record<string, unknown>): Promise<bigint> {
    if (this.closed) return this.inner.openSubgroup(alias, groupId, subgroupId, options);
    const standIn = this.nextStandIn--;
    void this.hold(0, `s${standIn}`, async () => {
      this.streams.set(standIn, await this.inner.openSubgroup(alias, groupId, subgroupId, options));
    });
    return Promise.resolve(standIn);
  }

  sendObject(streamId: bigint, objectId: unknown, payload: Uint8Array, extensions?: Uint8Array): Promise<void> {
    return this.hold(payload.byteLength + (extensions?.byteLength ?? 0), `s${streamId}`, async () => {
      const real = this.real(streamId);
      if (real !== null) await this.inner.sendObject(real, objectId, payload, extensions);
    });
  }

  closeSubgroup(streamId: bigint): Promise<void> {
    return this.hold(0, `s${streamId}`, async () => {
      const real = this.real(streamId);
      this.streams.delete(streamId);
      if (real !== null) await this.inner.closeSubgroup(real);
    });
  }

  /** Send everything held, in order; the next group's calls are held again. */
  flush(): void {
    if (this.closed) return;
    this.counts.flushes++;
    this.passthrough = false;
    this.release();
  }

  /** Drop what is held and wait for any flush in progress. Later calls go straight through. */
  async close(): Promise<void> {
    this.closed = true;
    this.held = [];
    this.heldBytes = 0;
    await this.chain;
  }

  /** Payload bytes held now. */
  get bytesHeld(): number {
    return this.heldBytes;
  }

  private real(streamId: bigint): bigint | null {
    return streamId >= 0n ? streamId : this.streams.get(streamId) ?? null;
  }

  private hold(bytes: number, lane: string, run: () => Promise<void>): Promise<void> {
    if (this.closed) {
      this.chain = this.chain.then(() => this.execute(run));
      return this.chain;
    }
    this.held.push({ bytes, lane, run });
    this.heldBytes += bytes;
    if (!this.passthrough && this.heldBytes > this.maxBytes) {
      this.passthrough = true;
      this.counts.capped++;
      this.onLog(`Group burst: group above ${this.maxBytes} bytes; sending the rest of it unheld`);
    }
    if (this.passthrough) this.release();
    return Promise.resolve();
  }

  private release(): void {
    const ops = this.held;
    this.held = [];
    this.heldBytes = 0;
    if (ops.length === 0) return;
    const replayed = ops.map((op) => {
      const next = (this.lanes.get(op.lane) ?? Promise.resolve()).then(() => this.execute(op.run));
      this.lanes.set(op.lane, next);
      void next.then(() => { if (this.lanes.get(op.lane) === next) this.lanes.delete(op.lane); });
      return next;
    });
    this.chain = Promise.all([this.chain, ...replayed]).then(() => {});
  }

  private async execute(run: () => Promise<void>): Promise<void> {
    try {
      await run();
    } catch (err) {
      this.counts.failures++;
      try { this.onError('group burst send', err); } catch { /* contained */ }
    }
  }
}
