/* Turn Media Drive items into the shapes src/core expects.
 *
 * The important finding: Media Drive metadata already carries a full camera
 * pose and the intrinsics. No COCO file is needed in production.
 *
 *   gpslat, gpslng, gpsalt, baseAltitude          -> camera centre
 *   gimbalyawdegree, gimbalpitchdegree,
 *   gimbalrolldegree                              -> orientation
 *   camfocallengthin35mmformat, exifimagewidth    -> focal length in pixels
 *
 * Annotations live on the item as stringified JSON keyed by addon id, with
 * labels carrying shapeType, category, severity, bbox and area.
 */

import { rotYPR, rotNadir } from '../core/pose.js';

/* Focal length in pixels. Prefer the 35 mm equivalent, which is what DJI
   writes and what maps cleanly onto a 36 mm reference frame. */
export function focalPx(meta) {
  const w = meta?.exifimagewidth || meta?.width;
  if (!w) return null;
  if (meta.camfocallengthin35mmformat)
    return w * meta.camfocallengthin35mmformat / 36;
  return null;   // camfocallength alone is useless without the sensor width
}

/* One Media Drive image item -> a pose, or null if it cannot make one.
   `assumeNadirIfMissing` mirrors the web tester's behaviour: only ever
   applied where real angles are absent, never over the top of them. */
export function poseFromItem(item, { assumeNadirIfMissing = false, heading = 0 } = {}) {
  const m = item.metadata || {};
  if (m.gpslat == null || m.gpslng == null) return null;

  const lat = m.gpslatref === 'S' ? -Math.abs(m.gpslat) : m.gpslat;
  const lng = m.gpslngref === 'W' ? -Math.abs(m.gpslng) : m.gpslng;
  const alt = m.gpsalt != null ? m.gpsalt
            : (m.baseAltitude != null ? m.baseAltitude : 0);

  const hasAngles = m.gimbalyawdegree != null && m.gimbalpitchdegree != null;
  let R, source, assumedAngles = false;
  if (hasAngles) {
    R = rotYPR(m.gimbalyawdegree, m.gimbalpitchdegree, m.gimbalrolldegree || 0);
    source = 'Media Drive gimbal';
  } else if (assumeNadirIfMissing) {
    R = rotNadir(heading);
    source = 'Media Drive position, nadir assumed';
    assumedAngles = true;
  } else {
    return null;
  }

  return {
    name: item.name,
    itemId: item.id,
    lonLatAlt: [lng, lat, alt],   // reprojected by the pipeline
    xyz: [lng, lat, alt],
    R,
    hasAngles,
    assumedAngles,
    fpx: focalPx(m),
    w: m.exifimagewidth || m.width || null,
    h: m.exifimageheight || m.height || null,
    source,
  };
}

/* Annotations on an item -> a flat list of detections.
   Only RECTANGLE and POLYGON carry usable geometry for ray casting. */
export function detectionsFromItem(item) {
  if (!item.annotations) return [];
  let parsed;
  try {
    parsed = typeof item.annotations === 'string'
      ? JSON.parse(item.annotations) : item.annotations;
  } catch {
    return [];
  }
  const out = [];
  for (const [addonId, addon] of Object.entries(parsed || {})) {
    const labels = addon?.labels || {};
    for (const [labelId, L] of Object.entries(labels)) {
      const bbox = normaliseBbox(L);
      if (!bbox) continue;
      out.push({
        labelId, addonId,
        imageItemId: item.id,
        image: item.name,
        category: L.category || 'detection',
        severity: L.severity ?? null,
        comment: L.comment || '',
        shapeType: L.shapeType || 'RECTANGLE',
        bbox,
        pixelArea: L.area ?? null,
        isAI: !!L.isAI,
        isAccepted: L.isAccepted !== false,
      });
    }
  }
  return out;
}

/* Labels may be a rectangle bbox or a polygon. Reduce a polygon to its
   bounding box for ray casting; keep the polygon for true area later. */
function normaliseBbox(L) {
  if (Array.isArray(L.bbox) && L.bbox.length >= 4) {
    const [a, b, c, d] = L.bbox.map(Number);
    if ([a, b, c, d].some(Number.isNaN)) return null;
    // Accept both [x,y,w,h] and [x1,y1,x2,y2]; width/height are never negative
    return (c > 0 && d > 0 && c < 1e5 && d < 1e5 && (c < a || d < b))
      ? [a, b, c, d]
      : (c > a && d > b ? [a, b, c - a, d - b] : [a, b, c, d]);
  }
  if (Array.isArray(L.points) && L.points.length > 2) {
    const xs = L.points.map(p => p[0]), ys = L.points.map(p => p[1]);
    const x0 = Math.min(...xs), y0 = Math.min(...ys);
    return [x0, y0, Math.max(...xs) - x0, Math.max(...ys) - y0];
  }
  return null;
}
