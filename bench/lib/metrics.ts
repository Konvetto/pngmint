/** Quality measures between two straight RGBA images of the same size. */
import ssimPkg from 'ssim.js';

// The CJS build exports an object with `ssim` and `default`; the types say a function.
const ssimFn: typeof ssimPkg =
  typeof ssimPkg === 'function' ? ssimPkg : (ssimPkg as unknown as { ssim: typeof ssimPkg }).ssim;

/**
 * PSNR in dB, peak 255 per channel. Colours are compared premultiplied (what the eye sees over
 * any background) and alpha is a channel of its own when the source has transparency.
 */
export function psnr(a: Uint8Array, b: Uint8Array, channels: 3 | 4): number {
  let sum = 0;
  for (let i = 0; i < a.length; i += 4) {
    const fa = a[i + 3]! / 255,
      fb = b[i + 3]! / 255;
    for (let c = 0; c < 3; c++) {
      const d = a[i + c]! * fa - b[i + c]! * fb;
      sum += d * d;
    }
    if (channels === 4) {
      const d = a[i + 3]! - b[i + 3]!;
      sum += d * d;
    }
  }
  const mse = sum / (a.length / 4);
  return mse === 0 ? Infinity : 10 * Math.log10((255 * 255 * channels) / mse);
}

/** Flattens straight RGBA over white (opaque RGBA out), so SSIM sees transparency as the viewer does. */
function overWhite(rgba: Uint8Array): Uint8ClampedArray {
  const out = new Uint8ClampedArray(rgba.length);
  for (let i = 0; i < rgba.length; i += 4) {
    const a = rgba[i + 3]! / 255;
    for (let c = 0; c < 3; c++) out[i + c] = rgba[i + c]! * a + 255 * (1 - a);
    out[i + 3] = 255;
  }
  return out;
}

/** Mean SSIM (ssim.js, Wang et al. 2004) on grayscale, both images flattened over white. */
export function ssimOverWhite(a: Uint8Array, b: Uint8Array, width: number, height: number): number {
  const img = (data: Uint8ClampedArray) => ({ data, width, height });
  return ssimFn(img(overWhite(a)), img(overWhite(b)), { ssim: 'fast' }).mssim;
}
