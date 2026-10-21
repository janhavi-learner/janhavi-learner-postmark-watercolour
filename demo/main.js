// Demo page for the watercolor engine: a 4:5 stamp, undo/redo arrows and the tuning panel.
// It uses the engine exactly the way the Postmark app does, through createEngine().
import { showOnScreen } from './errors.js';
import { createEngine } from '../engine/src/engine.js';

const STAMP_ASPECT = 4 / 5; // width / height
const canvas = document.getElementById('stamp');
const undoButton = document.getElementById('undo');
const redoButton = document.getElementById('redo');

// iOS Safari ignores user-scalable=no for pinch; block its gesture events directly.
for (const type of ['gesturestart', 'gesturechange', 'gestureend']) {
  document.addEventListener(type, (e) => e.preventDefault(), { passive: false });
}

// Fit a 4:5 stamp into the screen with a margin, above the undo/redo row.
function fitStamp() {
  const margin = 24;
  const historyRow = 44 + 12; // undo/redo buttons and the gap above them
  const availW = window.innerWidth - margin * 2;
  const availH = window.innerHeight - margin * 2 - historyRow;
  const cssW = Math.max(0, Math.floor(Math.min(availW, availH * STAMP_ASPECT)));
  canvas.style.width = `${cssW}px`;
  canvas.style.height = `${Math.floor(cssW / STAMP_ASPECT)}px`;
  return cssW;
}

async function start() {
  const cssW = fitStamp();
  const engine = await createEngine(canvas, { tune: true, onError: showOnScreen });
  engine.setBrush({ size: Math.round(cssW * 0.1) }); // a tenth of the stamp, as before

  window.addEventListener('resize', () => {
    fitStamp();
    engine.resize();
  });
  undoButton.addEventListener('click', () => engine.undo());
  redoButton.addEventListener('click', () => engine.redo());
  engine.onHistoryChange(({ canUndo, canRedo }) => {
    undoButton.disabled = !canUndo;
    redoButton.disabled = !canRedo;
  });
}

start().catch((e) => showOnScreen(e.message));
