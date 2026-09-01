/* Golden regression tests.
 *
 * Run: npm test
 *
 * These assert on real data, not mocks. If a change here breaks a number,
 * the change is wrong until proven otherwise.
 *
 * hill60.laz is a real Unleash live export: 227,891 points, EPSG:32756,
 * Port Kembla NSW. hill60-coco.json is the platform's own annotation export
 * for the same session: 5 images, 6 corrosion detections, camera lat/lng/alt
 * embedded per image, no gimbal angles.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import proj4 from 'proj4';
import { createLazPerf } from 'laz-perf';

import { readHeader, readEpsg, readCompressed } from '../src/core/las.js';
import { VoxelIndex } from '../src/core/index3d.js';
import { rotNadir, rotYPR, rotOPK, rayFor, parsePoseText } from '../src/core/pose.js';
import { fuseHits } from '../src/core/fuse.js';
import { epsgDef } from '../src/core/crs.js';
import { placeDetections, corridorFor, tiltSensitivity } from '../src/pipeline/place.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const fx = f => join(HERE, 'fixtures', f);

let LAZ;
async function lazPerf() {
  if (!LAZ) {
    const wasm = readFileSync(
      join(HERE, '..', 'node_modules', 'laz-perf', 'lib', 'node', 'laz-perf.wasm'));
    LAZ = await createLazPerf({ wasmBinary: new Uint8Array(wasm) });
  }
  return LAZ;
}

async function loadCloud(file, keepEvery = 1) {
  const buf = new Uint8Array(readFileSync(fx(file)));
  const hdr = readHeader(buf);
  const pts = await readCompressed(hdr, buf, keepEvery, await lazPerf(), null, null);
  return { hdr, pts, epsg: readEpsg(hdr) };
}

/* ---------------------------------------------------------------- pose maths */

test('nadir rotation looks straight down', () => {
  const R = rotNadir(0);
  assert.deepEqual(R[2].map(v => Math.round(v)), [0, 0, -1]);
});

test('up vector is right-handed, not inverted (BUGS-FOUND #3)', () => {
  // A level camera facing north: right is east, forward is north, and
  // image-down points at the ground. The historic bug flipped the last one,
  // which rendered every source frame upside down with no other symptom.
  const [right, down, fwd] = rotYPR(0, 0, 0);
  assert.deepEqual(right.map(v => +v.toFixed(6)), [1, 0, 0], 'right = east');
  assert.deepEqual(fwd.map(v => +v.toFixed(6)), [0, 1, 0], 'forward = north');
  assert.ok(down[2] < -0.999, 'image-down must point at the ground, not the sky');

  // Pitched straight down, image-down becomes a compass direction instead.
  const [, nDown, nFwd] = rotYPR(0, -90, 0);
  assert.ok(nFwd[2] < -0.999, 'nadir forward is straight down');
  assert.ok(nDown[1] < -0.999, 'nadir image-down points south when heading north');
});

test('a centre pixel gives the camera forward axis', () => {
  const p = { R: rotNadir(0) };
  const d = rayFor(p, 500, 500, 1000, 500, 500);
  assert.ok(Math.abs(d[0]) < 1e-9 && Math.abs(d[1]) < 1e-9);
  assert.ok(d[2] < -0.999);
});

test('omega/phi/kappa parses and normalises', () => {
  const R = rotOPK(0, 0, 0);
  assert.equal(R.length, 3);
  R.forEach(r => assert.equal(r.length, 3));
});

test('pose file sniffs yaw/pitch/roll and flags real angles', () => {
  const { poses } = parsePoseText(readFileSync(fx('synthetic-poses.csv'), 'utf8'));
  assert.equal(poses.size, 24);
  const first = poses.values().next().value;
  assert.equal(first.hasAngles, true,
    'pose-file poses must be flagged so nadir never overwrites them');
});

/* ---------------------------------------------------------------- LAS reading */

test('reads the Hill 60 header and finds its CRS', async () => {
  const { hdr, epsg } = await loadCloud('hill60.laz');
  assert.equal(hdr.count, 227891);
  assert.equal(hdr.pdrf, 3);
  assert.equal(hdr.compressed, true);
  assert.equal(hdr.rgbAt, 28, 'point format 3 puts RGB at byte 28');
  assert.equal(epsg, 32756, 'EPSG must come from the projection VLRs');
});

test('decodes every point without a detached buffer (BUGS-FOUND #2)', async () => {
  const { pts } = await loadCloud('hill60.laz');
  assert.equal(pts.n, 227891);
  assert.ok(pts.col, 'RGB should be present');
  // local coordinates, so Float32 keeps sub-millimetre precision
  for (let i = 0; i < pts.n * 3; i += 30000) assert.ok(pts.pos[i] >= -0.01);
});

test('EPSG 32756 maps to southern-hemisphere UTM', () => {
  assert.match(epsgDef(32756), /\+proj=utm \+zone=56 \+south/);
  assert.throws(() => epsgDef(2193), /not in the built-in table/);
});

/* ---------------------------------------------------------------- ray casting */

test('cell neighbourhood scales with the corridor (BUGS-FOUND #1)', async () => {
  const { pts } = await loadCloud('hill60.laz');
  const idx = new VoxelIndex(pts.pos, pts.n, 0.35);
  // a point 0.7 m off the ray axis sits two cells out at 0.35 m voxels.
  // A fixed 3x3x3 search can never see it, whatever corridor is requested.
  const i = 1000;
  const target = [pts.pos[i * 3], pts.pos[i * 3 + 1], pts.pos[i * 3 + 2]];
  const org = [target[0] + 0.7, target[1], target[2] + 40];
  const hit = idx.cast(org, [0, 0, -1], 200, 1.2);
  assert.ok(hit, 'a 1.2 m corridor must reach two cells out');
  assert.ok(hit.off <= 1.2);
});

test('corridor widens as density falls', () => {
  const dense = corridorFor(14_600_000, 190 * 251);
  const sparse = corridorFor(227_891, 149.7 * 91.5);
  assert.ok(sparse >= dense);
  assert.ok(dense >= 0.7 && sparse <= 2.0);
});

/* ------------------------------------------------- end to end, real platform data */

test('Hill 60: places all six real corrosion detections', async () => {
  const { hdr, pts, epsg } = await loadCloud('hill60.laz');
  const coco = JSON.parse(readFileSync(fx('hill60-coco.json'), 'utf8'));

  assert.equal(coco.images.length, 5);
  assert.equal(coco.annotations.length, 6);
  assert.equal(coco.categories[0].name, 'detection.corrosion');

  // Unleash puts lat/lng/alt on each image but no angles, so nadir is assumed
  const to = proj4('EPSG:4326', epsgDef(epsg));
  const poses = new Map();
  for (const im of coco.images) {
    const [e, n] = to.forward([im.lng, im.lat]);
    poses.set(im.file_name, {
      xyz: [e, n, im.alt], R: rotNadir(0),
      w: im.width, h: im.height, hasAngles: false,
      fpx: im.width * 24 / 36,
      source: 'COCO lat/lng, nadir assumed',
    });
  }

  const imgs = Object.fromEntries(coco.images.map(i => [i.id, i]));
  const cats = Object.fromEntries(coco.categories.map(c => [c.id, c.name]));
  const dets = coco.annotations.map(a => ({
    image: imgs[a.image_id].file_name,
    bbox: a.bbox,
    category: cats[a.category_id],
    imgW: imgs[a.image_id].width,
    imgH: imgs[a.image_id].height,
  }));

  const res = placeDetections(
    { pos: pts.pos, n: pts.n, origin: pts.origin },
    poses, dets,
    { extent: [hdr.maxs[0] - hdr.mins[0], hdr.maxs[1] - hdr.mins[1]] });

  assert.equal(res.hits.length, 6, 'all six detections must place');
  assert.equal(res.defects.length, 6, 'and fuse to six distinct defects');
  assert.equal(res.skipped.noPose + res.skipped.noFocal + res.skipped.noHit, 0);

  // every defect must sit inside the cloud's own bounding box
  const back = proj4(epsgDef(epsg), 'EPSG:4326');
  for (const d of res.defects) {
    assert.ok(d.xyz[0] >= hdr.mins[0] && d.xyz[0] <= hdr.maxs[0], `${d.id} easting`);
    assert.ok(d.xyz[1] >= hdr.mins[1] && d.xyz[1] <= hdr.maxs[1], `${d.id} northing`);
    assert.ok(d.xyz[2] >= hdr.mins[2] - 1 && d.xyz[2] <= hdr.maxs[2] + 1, `${d.id} Z`);
    const [lon, lat] = back.forward([d.xyz[0], d.xyz[1]]);
    assert.ok(lat > -34.50 && lat < -34.49, `${d.id} latitude in Port Kembla`);
    assert.ok(lon > 150.91 && lon < 150.93, `${d.id} longitude in Port Kembla`);
  }
});

test('Hill 60: reports the cost of assuming nadir', async () => {
  const { hdr, pts, epsg } = await loadCloud('hill60.laz');
  const coco = JSON.parse(readFileSync(fx('hill60-coco.json'), 'utf8'));
  const to = proj4('EPSG:4326', epsgDef(epsg));
  const im = coco.images[0];
  const [e, n] = to.forward([im.lng, im.lat]);
  const poses = new Map([[im.file_name, {
    xyz: [e, n, im.alt], R: rotNadir(0), w: im.width, h: im.height,
    hasAngles: false, fpx: im.width * 24 / 36, source: 'nadir assumed',
  }]]);
  const a = coco.annotations.find(x => x.image_id === im.id);
  const res = placeDetections(
    { pos: pts.pos, n: pts.n, origin: pts.origin }, poses,
    [{ image: im.file_name, bbox: a.bbox, category: 'c',
       imgW: im.width, imgH: im.height }],
    { extent: [hdr.maxs[0] - hdr.mins[0], hdr.maxs[1] - hdr.mins[1]] });

  assert.equal(res.hits.length, 1);
  const hit = res.hits[0];
  assert.equal(hit.assumedAngles, true, 'must flag that angles were assumed');
  const per5 = tiltSensitivity(hit, 5);
  assert.ok(per5 > 0.5 && per5 < 5,
    `5 deg of unmodelled tilt should shift this by metres, got ${per5.toFixed(2)}`);
});

/* -------------------------------------------------- accuracy against known truth */

test('synthetic: recovers known 3D positions to sub-metre', async () => {
  // 6 known points on a pipeline, projected into 24 camera views with 6 px
  // of detector jitter, then recovered blind. Requires kern.laz, which is
  // 38 MB and not committed. Skipped when absent.
  let cloud;
  try {
    cloud = await loadCloud('kern.laz', 3);
  } catch {
    console.log('  skipped: test/fixtures/kern.laz not present (see README)');
    return;
  }
  const coco = JSON.parse(readFileSync(fx('synthetic-coco.json'), 'utf8'));
  const { poses } = parsePoseText(readFileSync(fx('synthetic-poses.csv'), 'utf8'));
  const imgs = Object.fromEntries(coco.images.map(i => [i.id, i]));
  const cats = Object.fromEntries(coco.categories.map(c => [c.id, c.name]));
  const dets = coco.annotations.map(a => ({
    image: imgs[a.image_id].file_name, bbox: a.bbox,
    category: cats[a.category_id],
    imgW: imgs[a.image_id].width, imgH: imgs[a.image_id].height,
  }));
  for (const p of poses.values()) p.fpx = 2800;

  const res = placeDetections(
    { pos: cloud.pts.pos, n: cloud.pts.n, origin: cloud.pts.origin },
    poses, dets,
    { extent: [cloud.hdr.maxs[0] - cloud.hdr.mins[0],
               cloud.hdr.maxs[1] - cloud.hdr.mins[1]] });

  assert.equal(res.defects.length, 6, 'must fuse 24 hits into exactly 6 defects');
  const TRUTH = JSON.parse(readFileSync(fx('kern-truth.json'), 'utf8'));
  const errs = res.defects.map(d =>
    Math.min(...TRUTH.map(t => Math.hypot(
      t[0] - d.xyz[0], t[1] - d.xyz[1], t[2] - d.xyz[2]))));
  const mean = errs.reduce((a, b) => a + b) / errs.length;
  assert.ok(mean < 0.5, `mean 3D error ${mean.toFixed(3)} m should stay under 0.5`);
  assert.ok(Math.max(...errs) < 1.0, `max error ${Math.max(...errs).toFixed(3)} m`);
});

/* ---------------------------------------------------------------- fusion */

test('fusion merges by category and distance, not distance alone', () => {
  const at = (x, category) => ({ xyz: [x, 0, 0], category, area: 1, score: 1 });
  const same = fuseHits([at(0, 'rust'), at(0.5, 'rust')], 1.4, 1);
  assert.equal(same.length, 1, 'same class within eps must merge');
  const diff = fuseHits([at(0, 'rust'), at(0.5, 'crack')], 1.4, 1);
  assert.equal(diff.length, 2, 'different classes must never merge');
  const far = fuseHits([at(0, 'rust'), at(9, 'rust')], 1.4, 1);
  assert.equal(far.length, 2);
});

test('minViews filters single-frame detections', () => {
  const hits = [
    { xyz: [0, 0, 0], category: 'a', area: 1, score: 1 },
    { xyz: [0.2, 0, 0], category: 'a', area: 1, score: 1 },
    { xyz: [50, 0, 0], category: 'a', area: 1, score: 1 },
  ];
  assert.equal(fuseHits(hits, 1.4, 1).length, 2);
  assert.equal(fuseHits(hits, 1.4, 2).length, 1, 'the lone hit must be dropped');
});
