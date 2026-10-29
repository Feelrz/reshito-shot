// Person cut-out (FOCUS mode) — MediaPipe Selfie Segmentation, self-hosted in /vendor.
// Works offline and for both camera frames and uploaded photos.
import { loadScript, makeCanvas } from './util.js';

const BASE = new URL('../vendor/selfie_segmentation/', import.meta.url).href;
// Some static hosts refuse unusual extensions (.binarypb/.tflite); the build can ship them under aliases.
const ALIAS = { 'selfie_segmentation.binarypb': 'selfie_segmentation.binarypb', 'selfie_segmentation.tflite': 'selfie_segmentation.tflite', 'selfie_segmentation_landscape.tflite': 'selfie_segmentation_landscape.tflite' };
const locate = (f) => BASE + (ALIAS[f] || f);

export const Seg = {
  status: 'idle',          // idle | loading | ready | failed
  ready: null,             // Promise<boolean>
  onChange: () => {},
  ss: null,
  job: null,
  chain: Promise.resolve(),
  errors: 0,
  mc: null, mctx: null,

  init() {
    if (this.ready) return this.ready;
    this.status = 'loading';
    this.onChange();
    this.ready = (async () => {
      try {
        if (!window.SelfieSegmentation) await loadScript(BASE + 'selfie_segmentation.js');
        const ss = new window.SelfieSegmentation({ locateFile: locate });
        ss.setOptions({ modelSelection: 0, selfieMode: false });
        ss.onResults((r) => this.read(r));
        await ss.initialize();
        this.ss = ss;
        const [warm, wctx] = makeCanvas(64, 80);
        wctx.fillStyle = '#888'; wctx.fillRect(0, 0, 64, 80);
        await this.send(warm, 16, 20);         // compiles shaders up-front
        this.status = 'ready';
      } catch (err) {
        console.warn('[receipt-booth] cut-out model unavailable:', err);
        this.status = 'failed';
      }
      this.onChange();
      return this.status === 'ready';
    })();
    return this.ready;
  },

  read(results) {
    const job = this.job;
    if (!job || !results || !results.segmentationMask) return;
    const { w, h } = job;
    if (!this.mc || this.mc.width !== w || this.mc.height !== h) {
      [this.mc, this.mctx] = makeCanvas(w, h, { willReadFrequently: true });
    }
    const ctx = this.mctx;
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(results.segmentationMask, 0, 0, w, h);
    const d = ctx.getImageData(0, 0, w, h).data;
    // person confidence lives in alpha (and red) — pick whichever channel actually varies
    let aMin = 255, aMax = 0;
    for (let i = 3; i < d.length; i += 64) { const a = d[i]; if (a < aMin) aMin = a; if (a > aMax) aMax = a; }
    const ch = aMax - aMin > 8 ? 3 : 0;
    const out = new Float32Array(w * h);
    for (let i = 0, j = ch; i < out.length; i++, j += 4) out[i] = d[j] / 255;
    job.out = out;
  },

  async send(source, w, h) {
    this.job = { w, h, out: null };
    await this.ss.send({ image: source });
    const out = this.job.out;
    this.job = null;
    return out;
  },

  // Returns Float32Array(w*h) with 1 = person, or null. Calls are serialised.
  segment(source, w, h) {
    if (this.status !== 'ready') return Promise.resolve(null);
    const run = this.chain.then(async () => {
      try { return await this.send(source, w, h); }
      catch (err) {
        if (++this.errors > 6) { this.status = 'failed'; this.onChange(); }
        console.warn(err);
        return null;
      }
    });
    this.chain = run.catch(() => null);
    return run;
  },
};
