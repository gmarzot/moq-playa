import { describe, it, expect, vi } from 'vitest';
import { handleRecoveryAction } from './player-pipeline.js';
import { MoqtPlayer } from './player.js';

const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;
const callbacks = () => ({ onQualityReduced: vi.fn(), onResubscribe: vi.fn(), onTerminate: vi.fn() });

describe('recovery REQUEST_UPDATEs', () => {
  it('an audio skip forward stays local; a video skip forward resubscribes', () => {
    const audio = callbacks();
    handleRecoveryAction({ type: 'skip_forward' }, 'audio', null, log, audio);
    expect(audio.onResubscribe).not.toHaveBeenCalled();

    const video = callbacks();
    handleRecoveryAction({ type: 'skip_forward' }, 'video', null, log, video);
    expect(video.onResubscribe).toHaveBeenCalledWith('video');
  });

  it('sends at most one recovery REQUEST_UPDATE per media type every 2 s', () => {
    let nowUs = 10_000_000;
    const player = new MoqtPlayer({
      url: 'https://relay.example/moq', namespace: 'test', logLevel: 'none', clock: { now: () => nowUs },
    } as never);
    const requestUpdate = vi.fn(async (_requestId: unknown, _options: unknown) => {});
    (player as any).connection = { requestUpdate };
    (player as any).activeSubscriptions.set(2n, { trackName: 'video', mediaType: 'video', trackAlias: 1n });
    (player as any).activeSubscriptions.set(3n, { trackName: 'audio', mediaType: 'audio', trackAlias: 2n });
    const sent = () => requestUpdate.mock.calls.map((c) => BigInt(c[0] as bigint));

    (player as any).recoveryResubscribe('video');
    (player as any).recoveryResubscribe('video');
    nowUs += 1_000_000;
    (player as any).recoveryResubscribe('video');
    (player as any).recoveryResubscribe('audio');
    expect(sent()).toEqual([2n, 3n]);

    nowUs += 1_500_000;
    (player as any).recoveryResubscribe('video');
    (player as any).recoveryResubscribe('audio');
    expect(sent()).toEqual([2n, 3n, 2n]);
  });
});
