/* The placement pipeline.
 *
 * Input:  a decoded point cloud, camera poses, 2D detections
 * Output: fused defect instances with easting/northing/elevation and lat/lon
 *
 * This is source-agnostic on purpose. The web tester feeds it a LAZ plus a
 * COCO file; production feeds it a LAZ plus Media Drive metadata. Same code.
 */

import { VoxelIndex } from '../core/index3d.js';
import { rayFor } from '../core/pose.js';
import { fuseHits } from '../core/fuse.js';

export const DEFAULTS = {
  voxel: 0.35,
  fuseEps: 1.4,
  minViews: 1,
  maxRange: 500,
  wideRetryFactor: 3,
  wideRetryCap: 3.0,
};

/* Ray corridor scaled to the cloud's own density. A sparse cloud needs a
   wider corridor or thin structures are missed entirely. */
export function corridorFor(pointCount, areaM2) {
  const density = pointCount / Math.max(areaM2, 1);
  return Math.min(2.0, Math.max(0.7, 2.2 / Math.sqrt(Math.max(density, 0.5))));
}

/**
 * @param cloud   { pos: Float32Array (local), n, origin: [x,y,z] }
 * @param poses   Map<imageName, pose>  pose.xyz already in the cloud's CRS
 * @param dets    [{ image, bbox:[x,y,w,h], category, ... }]
 * @param opts    see DEFAULTS, plus focalPx fallback and an onLog callback
 */
export function placeDetections(cloud, poses, dets, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const log = o.onLog || (() => {});
  const O = cloud.origin;

  const areaM2 = (o.extent?.[0] || 1) * (o.extent?.[1] || 1);
  const corridor = o.corridor ?? corridorFor(cloud.n, areaM2);
  log(`ray corridor ${corridor.toFixed(2)} m`);

  const index = o.index || new VoxelIndex(cloud.pos, cloud.n, o.voxel);

  const hits = [];
  const skipped = { noPose: 0, noFocal: 0, noHit: 0 };
  let wide = 0, assumedFocal = false;

  for (const det of dets) {
    const p = poses.get(det.image);
    if (!p) { skipped.noPose++; continue; }

    const w = p.w || det.imgW;
    const h = p.h || det.imgH;
    let fpx = o.focalPx || p.fpx;
    if (!fpx && w) { fpx = w * 24 / 36; assumedFocal = true; }  // 24 mm equivalent
    if (!fpx) { skipped.noFocal++; continue; }

    const [bx, by, bw, bh] = det.bbox;
    const dir = rayFor(p, bx + bw / 2, by + bh / 2, fpx, w / 2, h / 2);
    const org = [p.xyz[0] - O[0], p.xyz[1] - O[1], p.xyz[2] - O[2]];

    let hit = index.cast(org, dir, o.maxRange, corridor);
    let viaWide = false;
    if (!hit) {
      hit = index.cast(org, dir, o.maxRange,
        Math.min(o.wideRetryCap, corridor * o.wideRetryFactor));
      viaWide = !!hit;
    }
    if (!hit) { skipped.noHit++; continue; }
    if (viaWide) wide++;

    const mPerPx = hit.t / fpx;
    const xyz = [hit.xyz[0] + O[0], hit.xyz[1] + O[1], hit.xyz[2] + O[2]];
    hits.push({
      ...det,
      xyz,
      t: hit.t,
      offset: hit.off,
      wide: viaWide,
      area: (bw * mPerPx) * (bh * mPerPx),
      cam: [p.xyz[0], p.xyz[1], p.xyz[2]],
      camBearing: (Math.atan2(p.xyz[0] - xyz[0], p.xyz[1] - xyz[1])
                   * 180 / Math.PI + 360) % 360,
      offNadir: Math.acos(Math.min(1, Math.max(-1, -dir[2]))) * 180 / Math.PI,
      assumedAngles: !p.hasAngles,
      poseSource: p.source,
      focalAssumed: assumedFocal && !p.fpx && !o.focalPx,
    });
  }

  log(`placed ${hits.length} of ${dets.length}`);
  if (skipped.noPose) log(`  ${skipped.noPose} without a pose`);
  if (skipped.noFocal) log(`  ${skipped.noFocal} without a focal length`);
  if (skipped.noHit) log(`  ${skipped.noHit} whose ray missed the cloud`);
  if (wide) log(`  ${wide} found only on a wider retry (gap in the cloud)`);
  if (assumedFocal) log('  focal length assumed at 24 mm equivalent');

  const defects = fuseHits(hits, o.fuseEps, o.minViews);
  log(`fused into ${defects.length} defects`);

  return { defects, hits, skipped, corridor, wide, index };
}

/* Positional uncertainty from an unmodelled tilt, in metres per degree.
   This is the number that justifies getting real gimbal angles into the
   pipeline rather than assuming nadir. */
export function tiltSensitivity(hit, degrees = 5) {
  const H = hit.t * Math.cos((hit.offNadir || 0) * Math.PI / 180);
  return H * Math.tan(degrees * Math.PI / 180);
}
