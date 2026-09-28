import React from 'react';
import { Check, Minus, Plus, RotateCcw } from 'lucide-react';
import { Menu } from '../ui';
import { ZOOM_MAX, ZOOM_MIN, ZOOM_STEPS, clampZoom, stepZoom } from '../zoom';

const pct = (z: number) => `${Math.round(z * 100)}%`;

/** The panel zoom in the top bar: a readout that opens steps, presets and reset. */
export const ZoomControl: React.FC<{ zoom: number; onZoom: (z: number) => void }> = ({ zoom, onZoom }) => {
  const set = (z: number) => onZoom(clampZoom(z));
  return (
    <Menu
      trigger={(t) => (
        <button className="zoom-btn" aria-label={`Panel zoom ${pct(zoom)}`} aria-haspopup="menu" data-tip="Panel zoom" {...t}>
          {pct(zoom)}
        </button>
      )}
    >
      {(close) => (
        <div className="zoom-menu" role="menu" aria-label="Panel zoom">
          <div className="menu-head">Panel zoom</div>
          <div className="zoom-step" role="group" aria-label="Zoom in or out">
            <button onClick={() => set(stepZoom(zoom, -1))} disabled={zoom <= ZOOM_MIN} aria-label="Zoom out">
              <Minus size={14} />
            </button>
            <span aria-live="polite">{pct(zoom)}</span>
            <button onClick={() => set(stepZoom(zoom, 1))} disabled={zoom >= ZOOM_MAX} aria-label="Zoom in">
              <Plus size={14} />
            </button>
          </div>
          <hr />
          {ZOOM_STEPS.map((z) => (
            <button key={z} role="menuitemradio" aria-checked={Math.abs(z - zoom) < 0.001} onClick={() => (set(z), close())}>
              <span className="grow">{pct(z)}</span>
              {z === 1 && <span className="dim">Default</span>}
              {Math.abs(z - zoom) < 0.001 && <Check size={13} />}
            </button>
          ))}
          <hr />
          <button onClick={() => (set(1), close())} disabled={zoom === 1}>
            <RotateCcw size={13} /> <span className="grow">Reset</span> <kbd>Ctrl 0</kbd>
          </button>
          <p className="zoom-hint">Ctrl + / − or Ctrl + scroll</p>
        </div>
      )}
    </Menu>
  );
};
