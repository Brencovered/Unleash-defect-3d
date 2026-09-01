# Browser tester

`index.html` is self-contained: three.js, proj4 and the laz-perf WebAssembly
decoder are all inlined. Open it directly, no server and no network needed.
Nothing is uploaded, which makes it safe on customer data.

## Using it

Drop in a point cloud (`.laz` or `.las`) and detections (COCO `.json`). Add
images for thumbnails, or a camera pose export for accuracy. Press
**Place detections**.

Poses are taken in this order:

1. an SfM pose export (Metashape XML, or CSV of `name,x,y,z` plus either
   `omega,phi,kappa` or `yaw,pitch,roll`)
2. EXIF and DJI XMP gimbal tags read off the uploaded JPEGs
3. `lat` / `lng` / `alt` embedded per image in an Unleash COCO export, with
   orientation assumed nadir

Real angles are never overwritten by the nadir assumption.

Exports GeoJSON, CSV and a Potree scene with annotations.

## Keeping it in sync

This file is built from `src/core` plus a UI layer. It is currently a
**snapshot**, not a build artefact: the core modules were extracted from it,
not the other way round. Before production, invert that so there is one copy
of the geometry code. `npm test` covers the extracted modules, not this file.
