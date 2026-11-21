/**
 * The libraries under test. Each takes straight RGBA, the size and a colour count and returns a
 * PNG file. libimagequant is GPL-3.0: it is a devDependency of this benchmark only and never
 * part of the package.
 */
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import * as iq from 'image-q';
import UPNG from 'upng-js';
import { zlibSync } from 'fflate';
import { quantize, quantizeSync } from '../../src/index.js';
import pkg from '../../package.json' with { type: 'json' };

/** The package name, so that renaming the package touches package.json and README only. */
export const NAME: string = pkg.name;

/** fflate at level 9: the optional deflate hook Konvetto passes in production. */
export const deflate = (raw: Uint8Array): Uint8Array => zlibSync(raw, { level: 9 });
export const HOOKED = `${NAME} (fflate hook)`;

const require = createRequire(import.meta.url);

export interface Contender {
  name: string;
  /** False for a lossless reference that ignores `colors`. */
  lossy: boolean;
  note?: string;
  run: (
    rgba: Uint8Array,
    width: number,
    height: number,
    colors: number,
  ) => Promise<Uint8Array> | Uint8Array;
}

/** Dithering per colour count, as the production presets use it. */
const dither = (colors: number) =>
  colors >= 256 ? 0 : colors >= 128 ? 0.4 : colors >= 64 ? 0.65 : 0.6;

/** The default install: no options beyond colours and dithering, CompressionStream for deflate. */
const pigmint: Contender = {
  name: NAME,
  lossy: true,
  run: async (rgba, w, h, colors) =>
    (await quantize(rgba, w, h, { maxColors: colors, dither: dither(colors) })).png,
};

/** The same palette and pixels, compressed through the optional deflate hook with fflate level 9. */
const pigmintHooked: Contender = {
  name: HOOKED,
  lossy: true,
  note: `${HOOKED}: identical pixels to ${NAME}, IDAT from fflate zlibSync level 9 through the deflate option`,
  run: (rgba, w, h, colors) =>
    quantizeSync(rgba, w, h, { maxColors: colors, dither: dither(colors), deflate }).png,
};

const upng: Contender = {
  name: 'upng-js',
  lossy: true,
  run: (rgba, w, h, colors) => {
    const copy = rgba.slice(); // UPNG writes into its input
    return new Uint8Array(UPNG.encode([copy.buffer], w, h, colors));
  },
};

const imageQ: Contender = {
  name: 'image-q',
  lossy: true,
  note: 'wuquant + floyd-steinberg; image-q has no PNG writer, its pixels are written losslessly by this package with the fflate hook',
  run: (rgba, w, h, colors) => {
    const pc = iq.utils.PointContainer.fromUint8Array(rgba, w, h);
    const palette = iq.buildPaletteSync([pc], { colors, paletteQuantization: 'wuquant' });
    const out = iq.applyPaletteSync(pc, palette, {
      imageQuantization: colors >= 256 ? 'nearest' : 'floyd-steinberg',
    });
    const pixels = out.toUint8Array();
    // At most `colors` colours: this is an exact, lossless write.
    return quantizeSync(pixels, w, h, { maxColors: 256, deflate }).png;
  },
};

let iqWasm: Promise<typeof import('imagequant')> | undefined;
async function loadImagequant() {
  iqWasm ??= (async () => {
    const bg =
      (await import('imagequant/imagequant_bg.js')) as unknown as WebAssembly.ModuleImports & {
        __wbg_set_wasm: (exports: WebAssembly.Exports) => void;
      };
    const bytes = await readFile(require.resolve('imagequant/imagequant_bg.wasm'));
    const { instance } = await WebAssembly.instantiate(bytes, { './imagequant_bg.js': bg });
    bg.__wbg_set_wasm(instance.exports);
    return bg as unknown as typeof import('imagequant');
  })();
  return iqWasm;
}

const libimagequant: Contender = {
  name: 'libimagequant',
  lossy: true,
  note: 'imagequant 0.1.2 wasm, speed 4 (default), max_colors set; GPL-3.0, benchmark only',
  run: async (rgba, w, h, colors) => {
    const { Imagequant, ImagequantImage } = await loadImagequant();
    const image = new ImagequantImage(rgba.slice(), w, h, 0);
    const q = new Imagequant();
    q.set_max_colors(colors);
    const out = q.process(image);
    q.free();
    return out;
  },
};

let oxi: Promise<(rgba: Uint8ClampedArray, w: number, h: number) => Uint8Array> | undefined;
async function loadOxipng() {
  oxi ??= (async () => {
    const mod = (await import('@jsquash/oxipng/codec/pkg/squoosh_oxipng.js')) as unknown as {
      default: (bytes: Uint8Array) => Promise<unknown>;
      optimise_raw: (
        d: Uint8ClampedArray,
        w: number,
        h: number,
        level: number,
        interlace: boolean,
        alpha: boolean,
      ) => Uint8Array;
    };
    await mod.default(
      await readFile(require.resolve('@jsquash/oxipng/codec/pkg/squoosh_oxipng_bg.wasm')),
    );
    return (rgba, w, h) => mod.optimise_raw(rgba, w, h, 2, false, false);
  })();
  return oxi;
}

const oxipng: Contender = {
  name: 'oxipng',
  lossy: false,
  note: 'lossless, level 2 (@jsquash/oxipng default): a size reference, not a competitor',
  run: async (rgba, w, h) => (await loadOxipng())(new Uint8ClampedArray(rgba), w, h),
};

export const contenders: Contender[] = [
  pigmint,
  pigmintHooked,
  upng,
  imageQ,
  libimagequant,
  oxipng,
];
