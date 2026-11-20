import { describe, expect, it } from 'vitest';
import { CmafCaptureMap } from './cmaf-capture-map.js';

const anchored = (map: CmafCaptureMap, group: bigint, startSec: number, captureUs: number): void => {
  map.noteCapture(group, captureUs);
  map.noteSegment(group, startSec);
};

describe('CmafCaptureMap', () => {
  it('interpolates a frame inside its group', () => {
    const map = new CmafCaptureMap();
    anchored(map, 10n, 4, 1_000_000);
    expect(map.captureUsAt(4)).toBe(1_000_000);
    expect(map.captureUsAt(4.5)).toBe(1_500_000);
  });

  it('uses the latest group starting at or before the frame', () => {
    const map = new CmafCaptureMap();
    anchored(map, 10n, 4, 1_000_000);
    anchored(map, 11n, 6, 9_000_000);
    expect(map.captureUsAt(5.9)).toBeCloseTo(2_900_000);
    expect(map.captureUsAt(6.1)).toBeCloseTo(9_100_000);
  });

  it('needs both the capture time and the segment start', () => {
    const map = new CmafCaptureMap();
    map.noteCapture(10n, 1_000_000);
    expect(map.captureUsAt(4)).toBeNull();
    map.noteSegment(11n, 4);
    expect(map.captureUsAt(4)).toBeNull();
  });

  it('keeps the first capture and the earliest start of a group', () => {
    const map = new CmafCaptureMap();
    map.noteCapture(10n, 1_000_000);
    map.noteCapture(10n, 2_000_000);
    map.noteSegment(10n, 4.1);
    map.noteSegment(10n, 4);
    expect(map.captureUsAt(4)).toBe(1_000_000);
  });

  it('has no answer before the first group or far past the last', () => {
    const map = new CmafCaptureMap();
    anchored(map, 10n, 4, 1_000_000);
    expect(map.captureUsAt(3.9)).toBeNull();
    expect(map.captureUsAt(40)).toBeNull();
  });

  it('forgets everything on clear', () => {
    const map = new CmafCaptureMap();
    anchored(map, 10n, 4, 1_000_000);
    map.clear();
    expect(map.captureUsAt(4)).toBeNull();
  });

  it('holds at most maxGroups, dropping the oldest', () => {
    const map = new CmafCaptureMap(2);
    anchored(map, 1n, 0, 100);
    anchored(map, 2n, 2, 200);
    anchored(map, 3n, 4, 300);
    expect(map.captureUsAt(1)).toBeNull();
    expect(map.captureUsAt(2)).toBe(200);
  });
});
