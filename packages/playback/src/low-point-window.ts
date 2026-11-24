/**
 * Minimum of timed samples over a window sized to the arrival cadence:
 * twice the largest gap between samples over the last HISTORY_SEC, the gap
 * still open at the query included, clamped to [MIN_SEC, MAX_SEC]. Steady
 * arrival gives MIN_SEC; burst arrival gives a window spanning the trough
 * before the latest burst.
 *
 * @module
 */
export class LowPointWindow {
    static readonly MIN_SEC = 0.25;
    static readonly MAX_SEC = 10;
    static readonly HISTORY_SEC = 10;
    /** Bound on retained samples; the oldest go first. */
    static readonly CAP = 2048;

    private times: number[] = [];
    private values: number[] = [];
    private head = 0;
    /** Gaps by end time, decreasing in size: the front is the largest. */
    private gapEnds: number[] = [];
    private gaps: number[] = [];
    private gapHead = 0;

    push(nowSec: number, value: number): void {
        const n = this.times.length;
        if (n > this.head) {
            const gap = nowSec - this.times[n - 1]!;
            while (this.gaps.length > this.gapHead && this.gaps[this.gaps.length - 1]! <= gap) {
                this.gaps.pop();
                this.gapEnds.pop();
            }
            this.gaps.push(gap);
            this.gapEnds.push(nowSec);
        }
        this.times.push(nowSec);
        this.values.push(value);
        this.prune(nowSec);
    }

    /** Window length (s) at `nowSec`. */
    windowSec(nowSec: number): number {
        const n = this.times.length;
        let gap = n > this.head ? nowSec - this.times[n - 1]! : 0;
        if (this.gaps.length > this.gapHead) gap = Math.max(gap, this.gaps[this.gapHead]!);
        return Math.min(Math.max(2 * gap, LowPointWindow.MIN_SEC), LowPointWindow.MAX_SEC);
    }

    /** Smallest sample within the window ending at `nowSec`, or null if none. */
    min(nowSec: number): number | null {
        this.prune(nowSec);
        const from = nowSec - this.windowSec(nowSec);
        let low: number | null = null;
        for (let i = this.times.length - 1; i >= this.head && this.times[i]! >= from; i--) {
            if (low === null || this.values[i]! < low) low = this.values[i]!;
        }
        return low;
    }

    clear(): void {
        this.times = [];
        this.values = [];
        this.head = 0;
        this.gapEnds = [];
        this.gaps = [];
        this.gapHead = 0;
    }

    private prune(nowSec: number): void {
        const horizon = nowSec - LowPointWindow.HISTORY_SEC;
        while (this.head < this.times.length
                && (this.times[this.head]! < horizon || this.times.length - this.head > LowPointWindow.CAP)) {
            this.head++;
        }
        while (this.gapHead < this.gaps.length && this.gapEnds[this.gapHead]! < horizon) this.gapHead++;
        if (this.head > LowPointWindow.CAP) {
            this.times = this.times.slice(this.head);
            this.values = this.values.slice(this.head);
            this.head = 0;
        }
        if (this.gapHead > LowPointWindow.CAP) {
            this.gaps = this.gaps.slice(this.gapHead);
            this.gapEnds = this.gapEnds.slice(this.gapHead);
            this.gapHead = 0;
        }
    }
}
