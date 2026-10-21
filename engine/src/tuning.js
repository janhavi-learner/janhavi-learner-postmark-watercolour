// Tuning panel (Tweakpane), only loaded when createEngine is called with { tune: true }.
// Tweakpane comes in through a dynamic import, so it isn't part of the app's first load.

export async function createTuningPane({ tuning, brush, onClear }) {
  const { Pane } = await import('tweakpane');
  const pane = new Pane({ title: 'Tuning', expanded: false });

  const b = pane.addFolder({ title: 'Brush' });
  b.addBinding(brush, 'size', { label: 'size px', min: 2, max: 120, step: 1 });
  b.addBinding(brush, 'taper', { label: 'taper', min: 0, max: 8, step: 0.1 });
  b.addBinding(tuning, 'pressure', { label: 'pressure', min: 0, max: 1, step: 0.01 });
  b.addBinding(brush, 'color', { label: 'color' });
  b.addBinding(brush, 'wet', { label: 'water brush' });

  const paint = pane.addFolder({ title: 'Paint' });
  paint.addBinding(brush, 'water', { label: 'water', min: 0, max: 1, step: 0.01 });
  paint.addBinding(tuning, 'darkPace', { label: 'dark pace', min: 1, max: 8, step: 0.1 });
  paint.addBinding(tuning, 'unevenness', { label: 'wash unevenness', min: 0, max: 1, step: 0.01 });
  paint.addBinding(tuning, 'granulation', { label: 'granulation', min: 0, max: 1.5, step: 0.01 });

  const wet = pane.addFolder({ title: 'Wet & drying' });
  wet.addBinding(tuning, 'dryingTime', { label: 'drying time s', min: 0.5, max: 40, step: 0.5 });
  wet.addBinding(tuning, 'spread', { label: 'spread speed', min: 0, max: 1, step: 0.01 });

  const edge = pane.addFolder({ title: 'Edge darkening' });
  edge.addBinding(tuning, 'edgeStrength', { label: 'strength', min: 0, max: 5, step: 0.05 });
  edge.addBinding(tuning, 'edgeWidth', { label: 'width px', min: 1, max: 20, step: 0.5 });

  const paper = pane.addFolder({ title: 'Paper' });
  paper.addBinding(tuning, 'grainSize', { label: 'grain size', min: 0.15, max: 1.5, step: 0.01 });
  paper.addBinding(tuning, 'grainContrast', { label: 'grain depth', min: 0, max: 4, step: 0.05 });

  pane.addButton({ title: 'Clear' }).on('click', onClear);
  return pane;
}
