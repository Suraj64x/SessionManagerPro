/**
 * The panel zoom (the top bar's zoom control) is CSS `zoom` on <html>. Screen coordinates —
 * getBoundingClientRect, pointer clientX/Y, innerWidth/innerHeight — come back in zoomed
 * pixels, while `position: fixed` offsets are applied before zooming. Anything positioned
 * from screen coordinates converts through these helpers, or it drifts by the zoom factor.
 */
export const ZOOM_STEPS = [0.8, 0.9, 1, 1.1, 1.25, 1.5];
export const ZOOM_MIN = 0.67;
export const ZOOM_MAX = 1.75;

export const pageZoom = (): number => parseFloat(getComputedStyle(document.documentElement).zoom) || 1;

/** The viewport in the panel's own CSS pixels. */
export const viewport = () => {
  const z = pageZoom();
  return { w: window.innerWidth / z, h: window.innerHeight / z };
};

/** An element's rect in the panel's own CSS pixels. */
export const layoutRect = (el: Element) => {
  const r = el.getBoundingClientRect();
  const z = pageZoom();
  return { left: r.left / z, top: r.top / z, right: r.right / z, bottom: r.bottom / z, width: r.width / z, height: r.height / z };
};

/** A pointer position in the panel's own CSS pixels. */
export const layoutPoint = (clientX: number, clientY: number) => {
  const z = pageZoom();
  return { x: clientX / z, y: clientY / z };
};

/** The next preset step up or down from `z`, clamped. */
export const stepZoom = (z: number, dir: 1 | -1): number => {
  const next = dir > 0 ? ZOOM_STEPS.find((s) => s > z + 0.001) : [...ZOOM_STEPS].reverse().find((s) => s < z - 0.001);
  return next ?? (dir > 0 ? ZOOM_STEPS[ZOOM_STEPS.length - 1] : ZOOM_STEPS[0]);
};

export const clampZoom = (z: number) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(z * 100) / 100));
