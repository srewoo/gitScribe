import {
  Output,
  BufferTarget,
  Mp4OutputFormat,
  WebMOutputFormat,
  CanvasSource,
  AudioBufferSource,
  canEncodeVideo,
  canEncodeAudio,
} from 'mediabunny';
import { drawFrame, type Scene } from './diagram-video.js';
import { renderSoundtrack, SAMPLE_RATE } from './video-audio.js';

/**
 * Encode a tour to a video file, frame by frame. Faster than real time and
 * exact: each frame is drawn at its own timestamp, so nothing is dropped
 * however busy the machine is.
 *
 * Runs in the panel page: WebCodecs is not exposed to service workers.
 */

export const FPS = 30;
const BITRATE = 6_000_000;

export interface Encoded {
  readonly blob: Blob;
  readonly extension: 'mp4' | 'webm';
  /** Set when H.264 was unavailable and WebM was produced instead. */
  readonly fallback?: string;
  /** Set when no audio encoder was available, so the video is silent. */
  readonly silent?: string;
}

export async function encodeTour(
  scene: Scene,
  opts: { onProgress?: (done: number) => void; signal?: AbortSignal } = {},
): Promise<Encoded> {
  const { w, h } = scene.size;
  const mp4 = await canEncodeVideo('avc', { width: w, height: h, bitrate: BITRATE });
  if (!mp4 && !(await canEncodeVideo('vp9', { width: w, height: h, bitrate: BITRATE }))) {
    throw new Error('This browser cannot encode video (no H.264 or VP9 encoder available).');
  }

  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not create a drawing surface for the video.');

  const output = new Output({
    format: mp4 ? new Mp4OutputFormat({ fastStart: 'in-memory' }) : new WebMOutputFormat(),
    target: new BufferTarget(),
  });
  const source = new CanvasSource(canvas, { codec: mp4 ? 'avc' : 'vp9', bitrate: BITRATE, keyFrameInterval: 2 });
  output.addVideoTrack(source, { frameRate: FPS });
  // AAC in MP4, Opus in WebM; if neither encoder exists, the video is silent and says so.
  const audioCodec = mp4 ? 'aac' : 'opus';
  const withAudio = await canEncodeAudio(audioCodec, { numberOfChannels: 2, sampleRate: SAMPLE_RATE, bitrate: 160_000 });
  const audio = withAudio ? new AudioBufferSource({ codec: audioCodec, bitrate: 160_000 }) : null;
  if (audio) output.addAudioTrack(audio);
  const soundtrack = audio ? renderSoundtrack(scene.tour, scene.segs) : null;
  await output.start();

  const frames = Math.ceil((scene.tour.totalMs / 1000) * FPS);
  try {
    for (let i = 0; i < frames; i++) {
      if (opts.signal?.aborted) throw new DOMException('Rendering was cancelled.', 'AbortError');
      drawFrame(ctx, scene, (i * 1000) / FPS);
      await source.add(i / FPS, 1 / FPS);
      if (i % 15 === 0) opts.onProgress?.(i / frames);
    }
    if (audio && soundtrack) await audio.add(await soundtrack);
    await output.finalize();
  } catch (e) {
    await output.cancel().catch(() => undefined);
    throw e;
  }
  opts.onProgress?.(1);

  const bytes = output.target.buffer;
  if (!bytes) throw new Error('The encoder produced no output.');
  const silent = audio ? {} : { silent: 'No audio encoder is available in this browser, so the video has no soundtrack.' };
  return mp4
    ? { blob: new Blob([bytes], { type: 'video/mp4' }), extension: 'mp4', ...silent }
    : {
      blob: new Blob([bytes], { type: 'video/webm' }), extension: 'webm', ...silent,
      fallback: 'H.264 is not available here, so this is a WebM file. Most players and sites accept it; some (e.g. iOS) do not.',
    };
}
