// Packs and unpacks saved paintings off the main thread, so saving never stalls painting.
import { encodePainting, decodePainting, extractTiles } from './storage.js';

self.onmessage = async ({ data: job }) => {
  try {
    if (job.op === 'encode') {
      const dryTiles = job.dry ? extractTiles(job.dry.pixels, job.dry.rect, job.dry.indices, job.layout, 3) : [];
      const wetTiles = job.wet
        ? extractTiles(job.wet.pixels, job.wet.rect, job.wet.indices, job.layout, 4).map((t, i) => ({ ...t, age: job.wet.ages[i] }))
        : [];
      self.postMessage({ id: job.id, blob: await encodePainting(job.layout, dryTiles, wetTiles) });
    } else if (job.op === 'decode') {
      const result = await decodePainting(job.data, job.layout);
      const buffers = [...result.dryTiles, ...result.wetTiles].map((t) => t.values.buffer);
      self.postMessage({ id: job.id, result }, buffers);
    }
  } catch (e) {
    self.postMessage({ id: job.id, error: e.message });
  }
};
