/* Unleash live Media Drive client.
 *
 * STATUS: written against the published schema at
 *   https://developer.unleashlive.com/api-documentation/media-drive/
 * It has NOT been run against the live API. No PAT was available while this
 * was written. Every function here is the shape the docs describe; treat the
 * first run as integration testing, not regression testing.
 *
 * Auth: Personal Access Token as a Bearer header. The legacy x-api-key header
 * is still accepted but should not be used for new work.
 *
 * API access is an optional add-on on the Unleash side. Confirm the account
 * has it enabled before debugging 403s.
 */

const GRAPHQL_URL = 'https://mediadrive-api.unleashlive.com/graphql';
const CDN_URL = 'https://library.unleashlive.com';

export const MIME = {
  FOLDER: 'application/vnd.unleashlive.folder',
  MODEL_PC: 'application/vnd.unleashlive.model.pc',
  MODEL_3D: 'application/vnd.unleashlive.model.3d',
};

export class MediaDrive {
  constructor({ token, url = GRAPHQL_URL, cdn = CDN_URL, fetchImpl } = {}) {
    if (!token) throw new Error('a Personal Access Token is required');
    this.token = token;
    this.url = url;
    this.cdn = cdn;
    this.fetch = fetchImpl || globalThis.fetch;
    if (!this.fetch) throw new Error('no fetch available; pass fetchImpl');
  }

  async gql(query, variables) {
    const res = await this.fetch(this.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.token}`,
      },
      body: JSON.stringify({ query, variables }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Media Drive HTTP ${res.status}: ${body.slice(0, 400)}`);
    }
    const json = await res.json();
    if (json.errors?.length) {
      throw new Error('Media Drive GraphQL: '
        + json.errors.map(e => e.message).join('; '));
    }
    return json.data;
  }

  /* One item, with the metadata the placement pipeline needs. */
  async getItem(id) {
    const data = await this.gql(`
      query GetItem($item: LibraryUpdateInput!) {
        get(item: $item) {
          id teamId parentId location name type mimeType s3Path
          annotations createdAt
          metadata {
            width height exifimagewidth exifimageheight
            gpslat gpslng gpsalt gpsaltref baseAltitude
            gimbalpitchdegree gimbalyawdegree gimbalrolldegree
            camfocallength camfocallengthin35mmformat
            make model size annotationCount
          }
        }
      }`, { item: { id } });
    return data.get;
  }

  /* Every child of a folder, following nextToken to the end.
     `location` is the parent's own location joined to its id with a slash. */
  async listAll({ location, type, limit = 200, maxPages = 100 }) {
    const out = [];
    let nextToken = null;
    for (let page = 0; page < maxPages; page++) {
      const data = await this.gql(`
        query List($location: String, $type: String, $limit: Int,
                   $nextToken: LastEvaluatedKeyInput) {
          list(sort: asc, location: $location, type: $type,
               limit: $limit, nextToken: $nextToken) {
            items {
              id teamId parentId location name type mimeType s3Path
              annotations createdAt
              metadata {
                width height exifimagewidth exifimageheight
                gpslat gpslng gpsalt gpsaltref baseAltitude
                gimbalpitchdegree gimbalyawdegree gimbalrolldegree
                camfocallength camfocallengthin35mmformat
              }
            }
            nextToken {
              pk sk locationCreatedAt teamId teamIdType createdAt
              searchNameCreatedAt searchName deviceId type
            }
          }
        }`, { location, type, limit, nextToken });
      out.push(...(data.list.items || []));
      nextToken = data.list.nextToken;
      if (!nextToken) break;
    }
    return out;
  }

  /* Images in a session folder. Type 'I' per the Item Type table. */
  listImages(location) { return this.listAll({ location, type: 'I' }); }

  /* Point cloud models in a session folder. Type 'M', filtered by mimeType. */
  async listPointClouds(location) {
    const models = await this.listAll({ location, type: 'M' });
    return models.filter(m => m.mimeType === MIME.MODEL_PC);
  }

  cdnUrl(s3Path) { return `${this.cdn}/${s3Path}`; }

  /* Raw bytes of a Media Drive file. Used for the LAZ. */
  async downloadBytes(s3Path, { onProgress } = {}) {
    const res = await this.fetch(this.cdnUrl(s3Path));
    if (!res.ok) throw new Error(`CDN HTTP ${res.status} for ${s3Path}`);
    const total = Number(res.headers.get('content-length')) || 0;
    if (!onProgress || !res.body?.getReader) {
      return new Uint8Array(await res.arrayBuffer());
    }
    const reader = res.body.getReader();
    const chunks = [];
    let got = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      got += value.length;
      onProgress(total ? got / total : 0, got, total);
    }
    const buf = new Uint8Array(got);
    let at = 0;
    for (const c of chunks) { buf.set(c, at); at += c.length; }
    return buf;
  }
}

/* ------------------------------------------------------------------ *
 * WRITE-BACK
 *
 * The published schema exposes move, rename and delete only. There is no
 * documented mutation for writing annotations. Until Unleash confirms one,
 * these are the options:
 *
 *   1. An unpublished annotation mutation exists  -> wire it here
 *   2. Upload results as a new Media Drive item   -> S3 SDK, see docs/API-NOTES.md
 *   3. A new mutation is required                 -> platform team work
 *
 * Nothing in this repo writes to the platform. Resolve this before building
 * the production job. See docs/API-NOTES.md.
 * ------------------------------------------------------------------ */
export function writeBackNotImplemented() {
  throw new Error(
    'No documented Media Drive mutation writes annotations. '
    + 'See docs/API-NOTES.md before implementing.');
}
