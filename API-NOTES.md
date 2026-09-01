# Unleash live API notes

Read against the published docs as of the date in the footer:
https://developer.unleashlive.com/

Nothing in this repo has been run against the live API. There was no Personal
Access Token available. `src/unleash/*` is written to the documented schema and
should be treated as unverified on first run.

---

## Which API

**Media Drive** is the one. GraphQL, `POST https://mediadrive-api.unleashlive.com/graphql`.

**Analytics is not.** It returns `class_name`, `count`, `frame_number`,
`model_id`, `session_id` for detections in video streams. No bounding boxes,
no camera pose, no per-image metadata. Useful for counting things in a
livestream and feeding Tableau. It cannot place anything in 3D.

Auth is a Bearer PAT. The legacy `x-api-key` header still works but should not
be used for new integrations. API access is an optional add-on on the account.

---

## What Media Drive gives us

### Camera pose, already stored

Per-image `metadata`:

| Field | Use |
|---|---|
| `gpslat`, `gpslng`, `gpsalt`, `gpsaltref` | camera centre |
| `baseAltitude` | fallback altitude |
| `gimbalyawdegree` | heading |
| `gimbalpitchdegree` | tilt, negative is downward in DJI convention |
| `gimbalrolldegree` | roll |
| `camfocallengthin35mmformat` | focal length, with `exifimagewidth` gives pixels |
| `exifimagewidth`, `exifimageheight` | sensor frame size |

That is a complete exterior orientation plus intrinsics. This is the single
most useful thing in the API for us, and it is exactly what the COCO export
currently drops.

`camfocallength` alone is not usable without the physical sensor width, which
is not exposed. Use the 35 mm equivalent.

### Annotations, already structured

`annotations` is stringified JSON keyed by add-on id. Each label carries:

`shapeType` (`RECTANGLE` / `POLYGON` / `POINT`), `category`, `severity`,
`comment`, `bbox`, `area`, `distance`, `isAI`, `isAccepted`, `isModified`.

Two things worth noting. `POLYGON` means real mask projection is possible, so
defect area can be a true measured figure rather than a bounding-box estimate.
And `isAccepted` means the pipeline can be restricted to human-reviewed
detections, which matters if the output feeds a work order.

### Point clouds

Items of type `M` with mimeType `application/vnd.unleashlive.model.pc`.
Download from `https://library.unleashlive.com/{s3Path}`.

### Listing

`list(location, type, limit, nextToken)` where `location` is the parent's own
`location` joined to its `id` with `/`. Paginate on `nextToken` until null.
Filter images with `type: "I"`.

---

## The blocker: writing results back

**The documented mutations are `move`, `rename` and `delete`. There is no
documented way to write an annotation.**

So the pipeline can compute defect positions and then has nowhere to put them.
Someone on the Unleash platform side has to pick one of these:

1. **An unpublished annotation mutation exists.** Best case. Wire it into
   `src/unleash/client.js` where `writeBackNotImplemented()` currently throws.

2. **Write results as a new Media Drive item.** Uploads go through the AWS S3
   SDK rather than GraphQL, with `location`, `name` and `deviceid` metadata
   linking the file into the drive. A GeoJSON or Potree scene JSON dropped
   beside the model would work and needs no API change. Downside: the results
   are a sibling file rather than annotations on the images, so the viewer
   would need to know to look for them.

3. **A new mutation is required.** This changes the estimate materially and
   needs to be scheduled on the platform roadmap, not the integration one.

**Resolve this before writing production code.** Everything upstream of it is
straightforward; this is the only part that could turn a six-week job into a
quarter.

---

## Suggested production shape

A worker triggered when a photogrammetry job completes:

1. `list` the session folder for images (`type: "I"`) and the point cloud
   (`type: "M"`, mimeType `...model.pc`)
2. Build poses from metadata, detections from annotations
3. Download the LAZ from the CDN, cache it
4. Decode, index, cast, fuse (`src/core` + `src/pipeline`, unchanged)
5. Reproject to WGS84
6. Write results (see blocker above)

Then the viewer only has to render annotations, which Potree already does, and
populate `orientedImages`, which Potree also already supports. None of the
heavy work belongs in the browser.

---

## Two small asks worth making regardless

1. **Put the gimbal fields in the COCO export.** They're already in the
   database. Three fields removes the need to assume nadir, which is currently
   worth metres of positional error.

2. **Carry the EPSG through to the Potree scene export.** The projection VLRs
   survive in the LAZ and get dropped from the viewer scene file, so the viewer
   has coordinates it can't turn into a lat/lon.
