/* EPSG code -> proj4 definition string.
   Covers WGS84 UTM north and south, which is what drone surveys land in.
   Anything else needs a real EPSG registry (proj4js defs or a lookup service). */

const KNOWN = {
  4326: '+proj=longlat +datum=WGS84 +no_defs',
  3857: '+proj=merc +a=6378137 +b=6378137 +lat_ts=0 +lon_0=0 +x_0=0 +y_0=0 '
      + '+k=1 +units=m +nadgrids=@null +no_defs',
};

export function epsgDef(code) {
  if (!code) throw new Error('no EPSG code supplied');
  if (KNOWN[code]) return KNOWN[code];
  if (code >= 32601 && code <= 32660)
    return `+proj=utm +zone=${code - 32600} +datum=WGS84 +units=m +no_defs`;
  if (code >= 32701 && code <= 32760)
    return `+proj=utm +zone=${code - 32700} +south +datum=WGS84 +units=m +no_defs`;
  throw new Error(
    `EPSG:${code} not in the built-in table. Add a proj4 def for it, or the `
    + `pipeline will leave positions in cloud coordinates with no lat/lon.`);
}

export function isSupported(code) {
  try { epsgDef(code); return true; } catch { return false; }
}
