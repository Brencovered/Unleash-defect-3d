/* Camera pose maths and pose-file parsing.
   See docs/BUGS-FOUND.md #3 before touching the up vector. */

function rotYPR(yawDeg, pitchDeg, rollDeg) {
  const y = yawDeg * Math.PI / 180, p = pitchDeg * Math.PI / 180, r = (rollDeg || 0) * Math.PI / 180;
  const f = [Math.sin(y) * Math.cos(p), Math.cos(y) * Math.cos(p), Math.sin(p)];
  let right = [f[1] * 1 - f[2] * 0, f[2] * 0 - f[0] * 1, f[0] * 0 - f[1] * 0];
  right = [f[1], -f[0], 0];
  let rl = Math.hypot(right[0], right[1], right[2]);
  if (rl < 1e-6) { right = [Math.cos(y), -Math.sin(y), 0]; rl = 1; }
  right = right.map(v => v / rl);
  let down = [f[1] * right[2] - f[2] * right[1],
              f[2] * right[0] - f[0] * right[2],
              f[0] * right[1] - f[1] * right[0]];
  const dl = Math.hypot(down[0], down[1], down[2]);
  down = down.map(v => v / dl);
  if (r) {
    const c = Math.cos(r), s = Math.sin(r);
    const nr = right.map((v, i) => c * v + s * down[i]);
    const nd = right.map((v, i) => -s * v + c * down[i]);
    right = nr; down = nd;
  }
  return [right, down, f];       // rows of world->camera
}

function rotNadir(headingDeg) { return rotYPR(headingDeg || 0, -90, 0); }

function rotOPK(omega, phi, kappa) {
  const o = omega * Math.PI / 180, p = phi * Math.PI / 180, k = kappa * Math.PI / 180;
  const co = Math.cos(o), so = Math.sin(o), cp = Math.cos(p), sp = Math.sin(p),
        ck = Math.cos(k), sk = Math.sin(k);
  const Rx = [[1, 0, 0], [0, co, -so], [0, so, co]];
  const Ry = [[cp, 0, sp], [0, 1, 0], [-sp, 0, cp]];
  const Rz = [[ck, -sk, 0], [sk, ck, 0], [0, 0, 1]];
  const mul = (A, B) => A.map(r => B[0].map((_, j) => r.reduce((s, v, k2) => s + v * B[k2][j], 0)));
  const flip = [[1, 0, 0], [0, -1, 0], [0, 0, -1]];
  const Rcw = mul(mul(mul(Rz, Ry), Rx), flip);
  return [[Rcw[0][0], Rcw[1][0], Rcw[2][0]],
          [Rcw[0][1], Rcw[1][1], Rcw[2][1]],
          [Rcw[0][2], Rcw[1][2], Rcw[2][2]]];
}

function rayFor(pose, u, v, fpx, cx, cy) {
  const dc = [(u - cx) / fpx, (v - cy) / fpx, 1.0];
  const R = pose.R;                                  // world->camera, rows
  const d = [R[0][0] * dc[0] + R[1][0] * dc[1] + R[2][0] * dc[2],
             R[0][1] * dc[0] + R[1][1] * dc[1] + R[2][1] * dc[2],
             R[0][2] * dc[0] + R[1][2] * dc[1] + R[2][2] * dc[2]];
  const n = Math.hypot(d[0], d[1], d[2]);
  return [d[0] / n, d[1] / n, d[2] / n];
}

function parsePoseText(text) {
  const lines = text.split(/\r?\n/);
  let header = '';
  const rows = [];
  for (const ln of lines) {
    const s = ln.trim();
    if (!s) continue;
    if (s.startsWith('#') || /[a-zA-Z]{3,}\s*[,\t]/.test(s)) {
      if (!header) header = s.toLowerCase();
      if (s.startsWith('#') || /^[a-z_,\t ]+$/i.test(s)) continue;
    }
    rows.push(s.split(/[,\t ]+/).filter(x => x !== ''));
  }
  const opk = /omega|kappa/.test(header);
  const geo = /\blat\b|\blon\b|latitude|longitude/.test(header);
  const poses = new Map();
  for (const r of rows) {
    if (r.length < 7) continue;
    const nums = r.slice(1, 7).map(Number);
    if (nums.some(isNaN)) continue;
    const name = r[0].split(/[\\/]/).pop();
    poses.set(name, {
      name,
      xyz: [nums[0], nums[1], nums[2]],
      R: opk ? rotOPK(nums[3], nums[4], nums[5]) : rotYPR(nums[3], nums[4], nums[5]),
      hasAngles: true,
      source: opk ? 'pose file (omega/phi/kappa)' : 'pose file (yaw/pitch/roll)'
    });
  }
  return {poses, geographic: geo};
}

export { rotYPR, rotNadir, rotOPK, rayFor, parsePoseText };
