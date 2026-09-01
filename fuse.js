/* Single-link clustering of per-image hits into defect instances.
   NOTE: O(n^2). Fine to a few thousand hits, must be rewritten beyond that. */

function fuseHits(hits, eps, minViews) {
  if (!hits.length) return [];
  const n = hits.length, parent = [...Array(n).keys()];
  const find = a => { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; };
  const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[rb] = ra; };
  for (let i = 0; i < n; i++)
    for (let j = i + 1; j < n; j++) {
      if (hits[i].category !== hits[j].category) continue;
      const d = Math.hypot(hits[i].xyz[0] - hits[j].xyz[0],
                           hits[i].xyz[1] - hits[j].xyz[1],
                           hits[i].xyz[2] - hits[j].xyz[2]);
      if (d <= eps) union(i, j);
    }
  const groups = new Map();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(i);
  }
  const out = [];
  let gi = 0;
  for (const idx of groups.values()) {
    const ms = idx.map(i => hits[i]);
    if (ms.length < (minViews || 1)) continue;
    gi++;
    const wsum = ms.reduce((s, m) => s + (m.score || 1), 0);
    const xyz = [0, 1, 2].map(k =>
      ms.reduce((s, m) => s + m.xyz[k] * (m.score || 1), 0) / wsum);
    const spread = ms.length > 1
      ? Math.max(...ms.map(m => Math.hypot(m.xyz[0] - xyz[0], m.xyz[1] - xyz[1], m.xyz[2] - xyz[2])))
      : 0;
    out.push({
      id: 'D' + String(gi).padStart(4, '0'),
      xyz, category: ms[0].category, views: ms.length,
      score: Math.max(...ms.map(m => m.score || 0)),
      spread: spread,
      area: ms.reduce((s, m) => s + m.area, 0) / ms.length,
      members: ms
    });
  }
  return out;
}

export { fuseHits };
