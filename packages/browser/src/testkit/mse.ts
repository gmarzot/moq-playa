/**
 * MSE test doubles: ISOBMFF builders and mock MediaSource / SourceBuffer /
 * video element shaped as MseMediaSource consumes them; the same doubles as
 * mse-adapter.test.ts, for tests outside it.
 */
import { vi, beforeEach, afterEach } from 'vitest';

// ─── Shared byte-building helpers (subset from mp4-box.test.ts) ──

export function cat(...parts: Uint8Array[]): Uint8Array {
    const total = parts.reduce((n, p) => n + p.byteLength, 0);
    const out = new Uint8Array(total);
    let o = 0;
    for (const p of parts) { out.set(p, o); o += p.byteLength; }
    return out;
}
export function u32(n: number): Uint8Array {
    const out = new Uint8Array(4);
    new DataView(out.buffer).setUint32(0, n);
    return out;
}
export function fourcc(type: string): Uint8Array {
    return new TextEncoder().encode(type);
}
export function box(type: string, body: Uint8Array): Uint8Array {
    return cat(u32(8 + body.byteLength), fourcc(type), body);
}
export function fullBox(type: string, version: number, flags: number, body: Uint8Array): Uint8Array {
    const vf = new Uint8Array(4);
    vf[0] = version & 0xff;
    vf[1] = (flags >> 16) & 0xff;
    vf[2] = (flags >> 8) & 0xff;
    vf[3] = flags & 0xff;
    return box(type, cat(vf, body));
}
export function tfdt(bmd: number): Uint8Array {
    return fullBox('tfdt', 0, 0, u32(bmd));
}
export function tfhd(trackId: number, dur?: number): Uint8Array {
    const flags = dur !== undefined ? 0x8 : 0;
    const body = dur !== undefined ? cat(u32(trackId), u32(dur)) : u32(trackId);
    return fullBox('tfhd', 0, flags, body);
}
export function trun(sampleCount: number): Uint8Array {
    return fullBox('trun', 0, 0, u32(sampleCount));
}
export function makeSegment(opts: {
    bmd: number;
    trackId?: number;
    defaultDur?: number;
    sampleCount: number;
}): Uint8Array {
    const trackId = opts.trackId ?? 1;
    return cat(
        box('moof', cat(
            box('traf', cat(tfhd(trackId, opts.defaultDur), tfdt(opts.bmd), trun(opts.sampleCount))),
        )),
        box('mdat', new Uint8Array(16)),
    );
}
/** Minimal init segment with an mvex/trex for trex-default tests. */
export function makeInit(trackId: number, defaultDur: number, timescale?: number): Uint8Array {
    // Wrap moov → mvex → trex. filterInitSegment won't run on a truly
    // minimal init (no trak/vide), so we build a slightly richer one.
    const trex = fullBox('trex', 0, 0, cat(
        u32(trackId), u32(1), u32(defaultDur), u32(0), u32(0),
    ));
    const mvex = box('mvex', trex);
    // Minimal trak with vide hdlr so filterInitSegment's selection
    // passes through.
    const hdlr = fullBox('hdlr', 0, 0, cat(
        u32(0),                  // pre_defined
        fourcc('vide'),          // handler_type
        u32(0), u32(0), u32(0),  // reserved
        new Uint8Array([0]),     // name (null terminator)
    ));
    // mdhd v0: creation, modification, timescale, duration, language + pre_defined.
    const mdhd = timescale === undefined ? new Uint8Array(0)
        : fullBox('mdhd', 0, 0, cat(u32(0), u32(0), u32(timescale), u32(0), u32(0)));
    const mdia = box('mdia', cat(mdhd, hdlr));
    const tkhd = fullBox('tkhd', 0, 0, cat(
        u32(0), u32(0), u32(trackId), u32(0),
        u32(0), u32(0), new Uint8Array(52),
    ));
    const trak = box('trak', cat(tkhd, mdia));
    const moov = box('moov', cat(trak, mvex));
    const ftyp = box('ftyp', cat(fourcc('iso6'), u32(0), fourcc('iso6')));
    return cat(ftyp, moov);
}

// ─── Mocks ────────────────────────────────────────────────────────
//
// Minimal SourceBuffer / MediaSource / HTMLVideoElement that model
// the exact surface the adapter uses. Kept in this file (not shared)
// because other adapter tests don't use MSE mocks.

export class MockEventTarget {
    private readonly listeners = new Map<string, Array<(e?: Event) => void>>();
    addEventListener(type: string, fn: (e?: Event) => void): void {
        const arr = this.listeners.get(type) ?? [];
        arr.push(fn);
        this.listeners.set(type, arr);
    }
    removeEventListener(type: string, fn: (e?: Event) => void): void {
        const arr = this.listeners.get(type);
        if (!arr) return;
        const idx = arr.indexOf(fn);
        if (idx >= 0) arr.splice(idx, 1);
    }
    /** Public: tests drive element events directly (e.g. a late `seeked`). */
    fire(type: string): void {
        const arr = this.listeners.get(type);
        if (!arr) return;
        for (const fn of arr.slice()) fn();
    }
    /** Dispatch a constructed Event (carries payload like addedRanges). */
    dispatch(event: Event): void {
        const arr = this.listeners.get(event.type);
        if (!arr) return;
        for (const fn of arr.slice()) fn(event);
    }
    /** Attached listener count — used to assert cleanup leaves nothing behind. */
    listenerCount(type: string): number {
        return this.listeners.get(type)?.length ?? 0;
    }
}

export class MockSourceBuffer extends MockEventTarget {
    updating = false;
    mode: 'segments' | 'sequence' = 'segments';
    timestampOffset = 0;
    readonly appendedPayloads: Uint8Array[] = [];
    buffered = makeTimeRanges([]);
    /** Throw on the NEXT appendBuffer call. */
    throwNextAppend?: Error;
    /** Throw on the NEXT remove() call. */
    throwNextRemove?: Error;
    /** When false, appends stay `updating` until the test fires updateend. */
    autoComplete = true;
    /** Fire an `error` before the next appendBuffer's `updateend` (MSE §5.5.3). */
    errorNextAppend = false;

    appendBuffer(data: ArrayBuffer | ArrayBufferView): void {
        if (this.throwNextAppend) {
            const err = this.throwNextAppend;
            this.throwNextAppend = undefined;
            throw err;
        }
        // Record a copy of the payload. The adapter passes `data.buffer`
        // (ArrayBuffer); normalize by reading the full range.
        const bytes = ArrayBuffer.isView(data)
            ? new Uint8Array((data as ArrayBufferView).buffer)
            : new Uint8Array(data);
        this.appendedPayloads.push(bytes);

        // Simulate async completion on a microtask turn. Per MSE §5.5.3 the
        // append-error algorithm queues `error` and THEN `updateend`, so a
        // failed append still terminates with updateend — the mock models both
        // events rather than substituting one for the other.
        this.updating = true;
        if (!this.autoComplete) return; // held in flight for the test to complete
        queueMicrotask(() => {
            this.updating = false;
            if (this.errorNextAppend) {
                this.errorNextAppend = false;
                this.fire('error');
            }
            this.fire('updateend');
        });
    }

    /** Every remove() call, recorded as [start, end]. */
    readonly removeCalls: Array<[number, number]> = [];

    remove(start: number, end: number): void {
        if (this.throwNextRemove) {
            const err = this.throwNextRemove;
            this.throwNextRemove = undefined;
            throw err;
        }
        this.removeCalls.push([start, end]);
        // Real MSE semantics: remove() sets updating, fires updateend, and the
        // removed span disappears from .buffered. Model both so eviction logic
        // doesn't loop forever against a never-shrinking buffer.
        this.updating = true;
        queueMicrotask(() => {
            const out: [number, number][] = [];
            for (let i = 0; i < this.buffered.length; i++) {
                const s = this.buffered.start(i);
                const e = this.buffered.end(i);
                if (e <= start || s >= end) { out.push([s, e]); continue; }
                if (s < start) out.push([s, start]);
                if (e > end) out.push([end, e]);
            }
            this.buffered = makeTimeRanges(out);
            this.updating = false;
            this.fire('updateend');
        });
    }

    /** Records every changeType mime so tests can assert the codec pivot. */
    readonly changeTypeCalls: string[] = [];
    changeType(mimeType: string): void {
        this.changeTypeCalls.push(mimeType);
    }
}

export class MockMediaSource extends MockEventTarget {
    readyState: 'closed' | 'open' | 'ended' = 'closed';
    /** Latest buffer per kind. A NEW instance per addSourceBuffer call, as a
     *  real MediaSource does — reusing one object would make the adapter's
     *  identity guard untestable. */
    videoBuffer = new MockSourceBuffer();
    audioBuffer = new MockSourceBuffer();
    /** Mime types passed to addSourceBuffer, for created-nothing assertions. */
    readonly addSourceBufferCalls: string[] = [];
    addSourceBuffer(mimeType: string): MockSourceBuffer {
        this.addSourceBufferCalls.push(mimeType);
        const sb = new MockSourceBuffer();
        if (mimeType.startsWith('video/')) this.videoBuffer = sb; else this.audioBuffer = sb;
        return sb;
    }
    removeSourceBuffer(_sb: unknown): void { /* no-op */ }
    endOfStream(): void { this.readyState = 'ended'; }
    open(): void {
        this.readyState = 'open';
        this.fire('sourceopen');
    }
}

export class MockVideoElement extends MockEventTarget {
    src = '';
    /** Present on real elements; the adapter feature-detects it for attachment. */
    srcObject: unknown = null;
    disableRemotePlayback = false;
    muted = false;
    paused = false;
    seeking = false;

    /**
     * Assigning currentTime starts an ASYNCHRONOUS seek, exactly as a real
     * element does: `seeking` latches immediately and `seeked` fires on a later
     * turn. Startup positioning depends on that lifecycle, so the mock models
     * it rather than pretending the assignment completes synchronously.
     *
     * With the lifecycle modelled, `seeking` latches true on assignment and is
     * cleared immediately before `seeked` fires. `autoFireSeeked = false` models
     * a browser that never completes the seek (the timeout path), leaving
     * `seeking` true. The lifecycle is OFF by default so suites that assign
     * currentTime and assert synchronously are unaffected.
     */
    private _currentTime = 0;
    seekCount = 0;

    /**
     * OFF by default so suites that assign currentTime and assert synchronously
     * (wedge watchdog, chase seeks) are unaffected. Startup-lifecycle tests turn
     * it ON to get the real behavior: `seeking` latches true on assignment and
     * clears immediately before `seeked` fires on a later turn.
     */
    modelSeekLifecycle = false;
    /** With the lifecycle modelled, suppress settlement (the timeout path). */
    autoFireSeeked = true;
    /** Model an element whose currentTime setter throws synchronously. */
    throwOnSeek: Error | null = null;

    get currentTime(): number { return this._currentTime; }
    set currentTime(v: number) {
        if (this.throwOnSeek) throw this.throwOnSeek;
        this._currentTime = v;
        this.seekCount++;
        if (!this.modelSeekLifecycle) return;
        this.seeking = true;                   // latches synchronously, as in a real element
        if (!this.autoFireSeeked) return;      // never settles — stays seeking
        queueMicrotask(() => {
            this.seeking = false;              // cleared BEFORE the event, per spec order
            this.fire('seeked');
        });
    }
    readyState = 4;
    error: { code: number; message: string } | null = null;
    buffered = makeTimeRanges([]);
    /** When true, play() rejects (autoplay blocked) → playTriggered stays false. */
    rejectPlay = false;
    playCalls = 0;
    pauseCalls = 0;
    /**
     * Model a play() that resolves LATER, as real elements do. The element is
     * playing once the promise resolves, so a pause issued while it is pending
     * is the case that a generation check alone cannot cover.
     */
    deferPlay: (() => Promise<void>) | null = null;
    async play(): Promise<void> {
        this.playCalls++;
        if (this.rejectPlay) throw new Error('autoplay blocked');
        if (this.deferPlay) await this.deferPlay();
        this.paused = false;
    }
    pause(): void {
        this.pauseCalls++;
        this.paused = true;
    }
    getVideoPlaybackQuality(): { totalVideoFrames: number; droppedVideoFrames: number } {
        return { totalVideoFrames: 100, droppedVideoFrames: 2 };
    }
    load(): void { /* no-op */ }
    removeAttribute(_n: string): void { /* no-op */ }
    /** Trigger the error event, setting .error first. */
    setError(code: number, message: string): void {
        this.error = { code, message };
        this.fire('error');
    }
}

export function makeTimeRanges(ranges: readonly [number, number][]): TimeRanges {
    return {
        length: ranges.length,
        start: (i: number) => ranges[i]![0],
        end: (i: number) => ranges[i]![1],
    } as unknown as TimeRanges;
}

/** Stub MediaSource and URL per test; `ms()` is the current test's MediaSource. */
export function installMseStubs(): { ms(): MockMediaSource } {
    let current: MockMediaSource;
    beforeEach(() => {
        current = new MockMediaSource();
        vi.stubGlobal('MediaSource', class { constructor() { return current; } });
        vi.stubGlobal('URL', {
            createObjectURL: () => 'blob:mock',
            revokeObjectURL: () => {},
        });
    });
    afterEach(() => {
        vi.unstubAllGlobals();
    });
    return { ms: () => current };
}

/** Flush queued microtasks so updateend handlers run. */
export async function flush(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
}
