/* Voxel-hashed point index with a ray-march intersector.
   See docs/BUGS-FOUND.md #1 before touching the cell neighbourhood. */

class VoxelIndex {
  /* Positions are Float32, local to `origin`. Cells are stored CSR-style
     (sorted keys + start offsets) so this holds millions of points without
     one JS array per cell. */
  constructor(pos, n, voxel) {
    this.pos = pos; this.n = n; this.v = voxel;
    let mx = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < n; i++)
      for (let k = 0; k < 3; k++) if (pos[i * 3 + k] > mx[k]) mx[k] = pos[i * 3 + k];
    this.dim = mx.map(v => Math.floor(v / voxel) + 2);
    const D1 = this.dim[1], D2 = this.dim[2];
    this.D1 = D1; this.D2 = D2;

    // one linear pass to map occupied cells to dense ids, then a counting sort
    const cellId = new Map();
    const perPoint = new Int32Array(n);
    for (let i = 0; i < n; i++) {
      const key = (Math.floor(pos[i * 3] / voxel) * D1
                   + Math.floor(pos[i * 3 + 1] / voxel)) * D2
                   + Math.floor(pos[i * 3 + 2] / voxel);
      let id = cellId.get(key);
      if (id === undefined) { id = cellId.size; cellId.set(key, id); }
      perPoint[i] = id;
    }
    const nc = cellId.size;
    const counts = new Uint32Array(nc + 1);
    for (let i = 0; i < n; i++) counts[perPoint[i] + 1]++;
    for (let c = 0; c < nc; c++) counts[c + 1] += counts[c];
    this.start = counts;                       // length nc+1, CSR offsets
    const cursor = counts.slice(0, nc);
    const order = new Uint32Array(n);
    for (let i = 0; i < n; i++) order[cursor[perPoint[i]]++] = i;
    this.order = order;
    this.cellId = cellId;
    this.ncells = nc;
  }

  _range(a, b, c) {
    if (a < 0 || b < 0 || c < 0 || a >= this.dim[0] || b >= this.dim[1] || c >= this.dim[2])
      return null;
    const id = this.cellId.get((a * this.D1 + b) * this.D2 + c);
    if (id === undefined) return null;
    return [this.start[id], this.start[id + 1]];
  }

  /* March the ray. Once a surface is found, refine by averaging the points
     that sit closest to the ray axis in a short slab around that range. */
  cast(origin, dir, tMax, radius) {
    radius = radius || this.v * 2.0;
    const step = this.v * 0.75;
    // a ±1 cell neighbourhood only covers ~one voxel of corridor; scale it
    const reachXY = Math.max(1, Math.ceil(radius / this.v));
    let hitT = null;
    for (let t = 0; t < tMax; t += step) {
      const a = Math.floor((origin[0] + dir[0] * t) / this.v);
      const b = Math.floor((origin[1] + dir[1] * t) / this.v);
      const c = Math.floor((origin[2] + dir[2] * t) / this.v);
      let best = null;
      for (let dx = -reachXY; dx <= reachXY; dx++)
        for (let dy = -reachXY; dy <= reachXY; dy++)
          for (let dz = -reachXY; dz <= reachXY; dz++) {
            const rg = this._range(a + dx, b + dy, c + dz);
            if (!rg) continue;
            for (let q = rg[0]; q < rg[1]; q++) {
              const i = this.order[q];
              const wx = this.pos[i * 3] - origin[0];
              const wy = this.pos[i * 3 + 1] - origin[1];
              const wz = this.pos[i * 3 + 2] - origin[2];
              const tt = wx * dir[0] + wy * dir[1] + wz * dir[2];
              if (tt <= 0.5) continue;
              const ox = wx - tt * dir[0], oy = wy - tt * dir[1], oz = wz - tt * dir[2];
              const off = Math.sqrt(ox * ox + oy * oy + oz * oz);
              if (off <= radius && (best === null || tt < best.t)) best = {t: tt, off: off};
            }
          }
      if (best) { hitT = best.t; break; }
    }
    if (hitT === null) return null;

    // refine: weighted mean of the on-axis points in a slab around hitT
    const slab = Math.max(1.0, this.v * 3);
    let sw = 0, sx = 0, sy = 0, sz = 0, minOff = 1e9, tBest = hitT;
    const reach = Math.ceil(slab / this.v) + 1;
    for (let s = -reach; s <= reach; s++) {
      const t = hitT + s * this.v;
      if (t < 0.5) continue;
      const a = Math.floor((origin[0] + dir[0] * t) / this.v);
      const b = Math.floor((origin[1] + dir[1] * t) / this.v);
      const c = Math.floor((origin[2] + dir[2] * t) / this.v);
      for (let dx = -reachXY; dx <= reachXY; dx++)
        for (let dy = -reachXY; dy <= reachXY; dy++)
          for (let dz = -reachXY; dz <= reachXY; dz++) {
            const rg = this._range(a + dx, b + dy, c + dz);
            if (!rg) continue;
            for (let q = rg[0]; q < rg[1]; q++) {
              const i = this.order[q];
              const wx = this.pos[i * 3] - origin[0];
              const wy = this.pos[i * 3 + 1] - origin[1];
              const wz = this.pos[i * 3 + 2] - origin[2];
              const tt = wx * dir[0] + wy * dir[1] + wz * dir[2];
              if (tt < hitT - slab || tt > hitT + slab) continue;
              const ox = wx - tt * dir[0], oy = wy - tt * dir[1], oz = wz - tt * dir[2];
              const off = Math.sqrt(ox * ox + oy * oy + oz * oz);
              if (off > radius) continue;
              const w = 1 / (0.05 + off * off);
              sw += w; sx += w * this.pos[i * 3]; sy += w * this.pos[i * 3 + 1];
              sz += w * this.pos[i * 3 + 2];
              if (off < minOff) { minOff = off; tBest = tt; }
            }
          }
    }
    if (!sw) return null;
    return {xyz: [sx / sw, sy / sw, sz / sw], t: tBest, off: minOff};
  }
}

export { VoxelIndex };
