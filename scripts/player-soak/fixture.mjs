/**
 * Synthetic camera and microphone for a headless g5-broadcast (Chrome's
 * --use-file-for-fake-video-capture / --use-file-for-fake-audio-capture): a
 * moving pattern with a white flash on each second's first frame, and a
 * 440 Hz tone with a 100 ms 1 kHz beep on each second. Both loop at 5.000 s,
 * so the flash and the beep stay aligned across loops.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';

const run = promisify(execFile);

export async function prepareCamera(dir, { width = 1280, height = 720, fps = 30, seconds = 5 } = {}) {
  await mkdir(dir, { recursive: true });
  const video = join(dir, `camera-${height}p${fps}.y4m`);
  const audio = join(dir, 'microphone.wav');
  const box = Math.round(height / 4.5);
  await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i',
    `testsrc2=size=${width}x${height}:rate=${fps},`
    + `drawbox=x=0:y=0:w=${box}:h=${box}:color=white:t=fill:enable='eq(mod(n\\,${fps})\\,0)'`,
    '-t', String(seconds), '-pix_fmt', 'yuv420p', video], { maxBuffer: 1 << 20 });
  await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i',
    "aevalsrc=exprs='if(lt(mod(t\\,1)\\,0.1)\\,0.5*sin(2*PI*1000*t)\\,0.3*sin(2*PI*440*t))':s=48000:c=stereo",
    '-t', String(seconds), '-c:a', 'pcm_s16le', audio], { maxBuffer: 1 << 20 });
  return { video, audio, width, height, fps };
}
