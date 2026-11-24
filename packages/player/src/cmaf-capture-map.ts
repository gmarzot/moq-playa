/** A frame further than this past its group's start is not trusted to the group's anchor. */
const MAX_SPAN_SEC = 30;

interface GroupAnchor {
  captureUs?: number;
  startSec?: number;
}

/** Recent CMAF video groups' capture times and media-timeline starts, for per-frame latency. */
export class CmafCaptureMap {
  private readonly groups = new Map<bigint, GroupAnchor>();

  constructor(private readonly maxGroups = 64) {}

  /** The first capture time seen for a group anchors it. */
  noteCapture(groupId: bigint, captureUs: number): void {
    const group = this.group(groupId);
    group.captureUs ??= captureUs;
  }

  noteSegment(groupId: bigint, startSec: number): void {
    const group = this.group(groupId);
    group.startSec = group.startSec === undefined ? startSec : Math.min(group.startSec, startSec);
  }

  /** Capture time (µs) of the frame at `mediaTimeSec`, or null when no group covers it. */
  captureUsAt(mediaTimeSec: number): number | null {
    let best: GroupAnchor | null = null;
    for (const group of this.groups.values()) {
      if (group.captureUs === undefined || group.startSec === undefined || group.startSec > mediaTimeSec) continue;
      if (best === null || group.startSec > best.startSec!) best = group;
    }
    if (best === null || mediaTimeSec - best.startSec! > MAX_SPAN_SEC) return null;
    return best.captureUs! + (mediaTimeSec - best.startSec!) * 1_000_000;
  }

  clear(): void {
    this.groups.clear();
  }

  private group(groupId: bigint): GroupAnchor {
    let group = this.groups.get(groupId);
    if (group === undefined) {
      group = {};
      this.groups.set(groupId, group);
      if (this.groups.size > this.maxGroups) this.groups.delete(this.groups.keys().next().value as bigint);
    }
    return group;
  }
}
