import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import { App } from './App.tsx'

// Suppress default browser right-click menu for professional desktop look
window.addEventListener('contextmenu', (e) => {
  // Allow right-click only inside inputs/textareas for paste
  const target = e.target as HTMLElement | null;
  if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) {
    return;
  }
  e.preventDefault();
});

// Suppress browser reload, print, view-source, and navigation shortcuts
window.addEventListener('keydown', (e) => {
  if (
    e.key === 'F5' ||
    e.key === 'F11' ||
    e.key === 'F12' ||
    (e.ctrlKey && ['r', 'R', 'p', 'P', 's', 'S', 'u', 'U', 'f', 'F', 'h', 'H'].includes(e.key)) ||
    (e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight'))
  ) {
    e.preventDefault();
  }
});

// Prevent dragging links or text that Edge would otherwise open in a browser window
window.addEventListener('dragover', (e) => e.preventDefault(), false);
window.addEventListener('drop', (e) => e.preventDefault(), false);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

