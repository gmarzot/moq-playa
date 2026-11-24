import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MoqtPlayer } from './player.js';

function makePlayer(latencyMode: 'live' | 'smooth') {
  const player = new MoqtPlayer({
    url: 'https://relay.example/moq', namespace: 'live/test',
    createTransport: async () => ({}) as any,
    createConnection: () => ({}) as any,
    latencyMode,
  } as any) as any;
  player.activeSubscriptions.set(1n, { mediaType: 'audio', trackName: 'audio', trackAlias: 7n });
  const fetch = vi.spyOn(player, 'fetch').mockResolvedValue(9n);
  const pipeline = { setMinGapTimeoutUs: vi.fn() };
  player.audioPipeline = pipeline;
  return { player, fetch, pipeline };
}

describe('MoqtPlayer audio datagram repair', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('Live flies through a lost datagram', async () => {
    const { player, fetch, pipeline } = makePlayer('live');
    player.noteAudioDatagram(7n, 10n, 0n);
    player.noteAudioDatagram(7n, 12n, 0n);
    await vi.advanceTimersByTimeAsync(100);
    expect(fetch).not.toHaveBeenCalled();
    expect(pipeline.setMinGapTimeoutUs).not.toHaveBeenCalled();
    expect(player.audioRepairStats).toBeNull();
  });

  it('Smooth fetches a lost datagram from the playing track and holds the gap', async () => {
    const { player, fetch, pipeline } = makePlayer('smooth');
    player.noteAudioDatagram(7n, 10n, 0n);
    player.noteAudioDatagram(7n, 12n, 0n);
    await vi.advanceTimersByTimeAsync(30);
    expect(fetch).toHaveBeenCalledWith('audio', { startGroup: 11n, startObject: 0n, endGroup: 11n, endObject: 0n });
    expect(pipeline.setMinGapTimeoutUs).toHaveBeenLastCalledWith(400_000);
  });

  it('keeps the hold inside a low Smooth floor', async () => {
    const { player, pipeline } = makePlayer('smooth');
    player.config = { ...player.config, smoothFloorMs: 200 };
    player.noteAudioDatagram(7n, 10n, 0n);
    expect(pipeline.setMinGapTimeoutUs).toHaveBeenLastCalledWith(130_000);
  });

  it('a new track starts a new sequence', async () => {
    const { player, fetch } = makePlayer('smooth');
    player.noteAudioDatagram(7n, 10n, 0n);
    player.noteAudioDatagram(8n, 12n, 0n);
    await vi.advanceTimersByTimeAsync(100);
    expect(fetch).not.toHaveBeenCalled();
  });
});
