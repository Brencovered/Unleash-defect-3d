# Bugs found during development

Four bugs. Three of them were silent: they produced plausible wrong answers
rather than throwing. Each has a regression test in `test/golden.test.mjs`.

If you are changing `src/core/index3d.js` or `src/core/pose.js`, read this
first.

---

## 1. Ray march searched a fixed 3×3×3 cell neighbourhood

**Silent. Cost: dropped detections, and a corridor parameter that did nothing.**

`VoxelIndex.cast` accepted a `radius` argument but only ever looked at the 27
cells immediately around the ray. With a 0.35 m voxel that caps the effective
search at roughly 0.35 m regardless of what you ask for.

On a dense cloud (305 pts/m²) it was invisible, because a point was always in
the immediate cell. On a sparse one (16.6 pts/m²) it silently dropped hits, and
widening the corridor to diagnose it changed nothing, which sent the
investigation in the wrong direction for an hour.

The neighbourhood now scales: `reach = ceil(radius / voxel)`.

Test: *cell neighbourhood scales with the corridor*.

Watch for: this makes the search cost cubic in the corridor width. A 3 m
corridor at 0.35 m voxels is 6,859 cells per step. Cap it.

---

## 2. DataView bound to a detached WebAssembly heap

**Loud, at least. Threw `Cannot perform DataView.prototype.getInt32 on a
detached or out-of-bounds ArrayBuffer`.**

laz-perf's wasm heap grows during decoding. When it does, the old ArrayBuffer
is detached and any DataView bound to it dies. The reader cached one view at
the start of the loop.

It now re-binds when it notices `HEAPU8.buffer` has changed.

Test: *decodes every point without a detached buffer*.

---

## 3. Up vector computed with the cross product operands reversed

**Silent, and the nastiest of the four.**

`up = cross(right, forward)` yields `(0,0,-1)` for a level camera facing north.
It should be `cross(forward, right)`.

The only symptom was that every rendered source frame came out upside down.
No error, no warning, correct positions, correct everything else. It survived
several rounds of review because the images looked like plausible aerial
photography either way up.

This is the same class of error as the Potree issue where Reality Capture
cameras load at the correct XYZ with the wrong rotation. **When wiring
`orientedImages` in production, check that the image planes render the right
way up before trusting anything downstream**, because a vertical flip silently
puts every detection box in the wrong place.

Test: *up vector is right-handed, not inverted*.

---

## 4. View bearing formula 180 degrees out

**Silent. Fed the compass, the HUD, the camera preset buttons and the
direction arrow, so all four agreed with each other and all four were wrong.**

With the scene mapped as x=East, y=Up, z=−North, the camera faces bearing
`−yaw`. The code had `yaw + 180`, which happens to be correct at yaw ±90 only.
A sanity check against an elevation raster landed on exactly that case and
passed.

Lesson: when several readouts derive from one formula, agreement between them
is not evidence. Check against something outside the system.

---

## Near miss, not a bug

Point size was computed from the density of the ray index rather than the
density of what was actually drawn. The index holds one point in three; the
renderer draws a further subsample. Sizing for the wrong one made points about
a third of the size needed to cover their own gaps, so the cloud rendered as
see-through speckle and looked like bad data.

Worth knowing because the same trap exists anywhere two different subsamples of
the same cloud are in play.
