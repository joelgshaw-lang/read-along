// Studio voices: the same Kokoro voices as the audiobooks, running on the phone itself.
// Runs in the background so the page stays smooth. The voice model (about 90 MB) downloads
// once and is then kept on the phone, so it works offline.
import { KokoroTTS } from 'https://cdn.jsdelivr.net/npm/kokoro-js@1.2.1/dist/kokoro.web.js';

let tts = null, loading = null;

function load(device) {
  if (!loading) {
    loading = KokoroTTS.from_pretrained('onnx-community/Kokoro-82M-v1.0-ONNX', {
      dtype: device === 'webgpu' ? 'fp32' : 'q8',
      device,
      progress_callback: (p) => {
        if (p.status === 'progress' && /onnx/.test(p.file || '')) self.postMessage({ type: 'progress', loaded: p.loaded, total: p.total });
      },
    }).then((t) => { tts = t; return t; });
  }
  return loading;
}

self.onmessage = async (e) => {
  const m = e.data;
  try {
    if (m.type === 'load') {
      const t0 = Date.now();
      await load(m.device || 'wasm');
      self.postMessage({ type: 'ready', ms: Date.now() - t0 });
    } else if (m.type === 'speak') {
      await load(m.device || 'wasm');
      const t0 = Date.now();
      const audio = await tts.generate(m.text, { voice: m.voice, speed: 1 });
      const wav = audio.toWav();
      self.postMessage({ type: 'audio', id: m.id, wav, secs: audio.audio.length / audio.sampling_rate, ms: Date.now() - t0 }, [wav]);
    }
  } catch (err) {
    if (m.type === 'load') loading = null;
    self.postMessage({ type: 'error', id: m.id, of: m.type, error: String((err && err.message) || err) });
  }
};
