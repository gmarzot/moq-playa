import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MediaCapture } from './media-capture.js';
import { PROGRAMME_AUDIO, VOICE_AUDIO } from './programme-audio.js';

const stream = { getVideoTracks: () => [], getAudioTracks: () => [], getTracks: () => [] };
const getUserMedia = vi.fn(async () => stream);
const getDisplayMedia = vi.fn(async () => stream);

beforeEach(() => {
  getUserMedia.mockClear();
  getDisplayMedia.mockClear();
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia, getDisplayMedia } });
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('MediaCapture — programme audio', () => {
  it('captures camera audio without voice processing', async () => {
    await new MediaCapture().startCamera({ width: 1280 });
    expect(getUserMedia).toHaveBeenCalledWith({ video: { width: 1280 }, audio: PROGRAMME_AUDIO });
    expect(PROGRAMME_AUDIO).toEqual({ echoCancellation: false, noiseSuppression: false, autoGainControl: false });
  });

  it('passes explicit camera audio constraints through, e.g. voice processing', async () => {
    await new MediaCapture().startCamera(undefined, VOICE_AUDIO);
    expect(getUserMedia).toHaveBeenCalledWith({ video: true, audio: VOICE_AUDIO });
    expect(VOICE_AUDIO).toEqual({ echoCancellation: true, noiseSuppression: true, autoGainControl: true });
  });

  it('leaves camera audio off when not asked for', async () => {
    await new MediaCapture().startCamera(undefined, false);
    expect(getUserMedia).toHaveBeenCalledWith({ video: true, audio: false });
  });

  it('captures screen audio without voice processing, and none when not asked for', async () => {
    await new MediaCapture().startScreen();
    expect(getDisplayMedia).toHaveBeenLastCalledWith({ video: true, audio: PROGRAMME_AUDIO });
    await new MediaCapture().startScreen({ video: { frameRate: { ideal: 30 } }, audio: false });
    expect(getDisplayMedia).toHaveBeenLastCalledWith({ video: { frameRate: { ideal: 30 } }, audio: false });
  });
});
