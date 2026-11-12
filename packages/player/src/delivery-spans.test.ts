import { describe, it, expect, vi } from 'vitest';
import { MoqtPlayer } from './player.js';
import { PlayerState } from './state.js';

describe('MoqtPlayer delivery spans', () => {
  it('records a LOCMAF object\'s socket-to-engine span, as for LOC and CMAF', () => {
    const player = new MoqtPlayer({ url: 'https://relay.example/moq', namespace: 'test', logLevel: 'none' } as never);
    vi.spyOn((player as any).stateMachine, 'state', 'get').mockReturnValue(PlayerState.PAUSED);
    const now = performance.now();
    for (const [trackName, bytes] of [['video', 3000], ['audio', 400]] as const) {
      (player as any).onLocmafMediaObject(trackName, trackName, {
        kind: 'data', trackAlias: 1n, groupId: 7n, subgroupId: 0n, objectId: 0n,
        payload: new Uint8Array(bytes), socketFirstMs: now - 30, socketLastMs: now - 10, assemblyBusyMs: 5,
      });
    }
    const spans = player.deliveryBreakdown;
    expect(spans.map((s) => s.bytes)).toEqual([400, 3000]);
    expect(spans[0]!.transferMs).toBeCloseTo(15, 0);
    expect(spans[0]!.assemblyMs).toBe(5);
  });
});
