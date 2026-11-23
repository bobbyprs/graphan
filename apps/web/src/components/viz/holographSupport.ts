import type { PanelType } from '@/api/types';

/** Panel types that have a holograph-3d equivalent (kept apart so the library itself stays lazy-loaded). */
export const HOLOGRAPH_TYPES: PanelType[] = ['bar', 'line', 'area', 'pie', 'gauge', 'scatter', 'heatmap', 'treemap'];

let webgl2: boolean | undefined;
export function supportsWebGL2() {
  if (webgl2 === undefined) {
    try {
      webgl2 = typeof document !== 'undefined' && !!document.createElement('canvas').getContext('webgl2');
    } catch {
      webgl2 = false;
    }
  }
  return webgl2;
}
