import { createRequire } from 'node:module';
import { Resvg } from '@resvg/resvg-js';

const require_ = createRequire(__filename);

let fonts: Record<'regular' | 'medium' | 'italic' | 'mediumItalic', Buffer> | undefined;
/** Roboto TTFs bundled with pdfmake (used by PDF output and chart rasterising, so no system fonts are needed). */
export function robotoFonts() {
  if (!fonts) {
    const vfs = require_('pdfmake/build/vfs_fonts') as Record<string, string>;
    const b = (n: string) => Buffer.from(vfs[n], 'base64');
    fonts = { regular: b('Roboto-Regular.ttf'), medium: b('Roboto-Medium.ttf'), italic: b('Roboto-Italic.ttf'), mediumItalic: b('Roboto-MediumItalic.ttf') };
  }
  return fonts;
}

/** Rasterises an SVG (charts, uploaded SVG images) to PNG for Excel, Word and e-mail. */
export function svgToPng(svg: string, width: number): { png: Buffer; width: number; height: number } {
  const f = robotoFonts();
  // resvg ignores `fitTo` when fontBuffers are given, so scale the SVG itself (viewBox keeps the drawing proportional)
  const scaled = svg.replace(/<svg(\s[^>]*)>/, (_m, attrs: string) => {
    const w = Number(/\swidth="([\d.]+)/.exec(attrs)?.[1]);
    const h = Number(/\sheight="([\d.]+)/.exec(attrs)?.[1]);
    if (!w || !h) return `<svg${attrs}>`;
    const k = width / w;
    let a = attrs.replace(/\swidth="[^"]*"/, ` width="${Math.round(w * k)}"`).replace(/\sheight="[^"]*"/, ` height="${Math.round(h * k)}"`);
    if (!/viewBox=/.test(a)) a += ` viewBox="0 0 ${w} ${h}"`;
    return `<svg${a}>`;
  });
  // fontBuffers is supported at runtime (resvg-js >= 2.5) but missing from its typings
  const opts = {
    font: { fontBuffers: [f.regular, f.medium], loadSystemFonts: false, defaultFontFamily: 'Roboto', sansSerifFamily: 'Roboto' },
    background: 'white',
  };
  const r = new Resvg(scaled, opts as ConstructorParameters<typeof Resvg>[1]);
  const img = r.render();
  return { png: img.asPng(), width: img.width, height: img.height };
}

export function decodeDataUri(src: string): { mime: string; data: Buffer } {
  const m = /^data:([^;]+);base64,(.*)$/s.exec(src);
  if (!m) throw new Error('Invalid image');
  return { mime: m[1], data: Buffer.from(m[2], 'base64') };
}

/** Page sizes in points (1/72 in). */
export const PAGE_PT: Record<string, [number, number]> = {
  A3: [841.89, 1190.55],
  A4: [595.28, 841.89],
  A5: [419.53, 595.28],
  LETTER: [612, 792],
  LEGAL: [612, 1008],
};
export const MM = 72 / 25.4;
