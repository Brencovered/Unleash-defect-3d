/* LAS/LAZ header, VLR/EPSG discovery and point reading.
   Pure: no DOM, no Node APIs. Runs in a browser, a worker or Node. */

function readHeader(buf) {
  const dv = new DataView(buf.buffer ? buf.buffer : buf, buf.byteOffset || 0, buf.byteLength);
  const sig = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3));
  if (sig !== 'LASF') throw new Error('Not a LAS or LAZ file (missing LASF signature)');
  const vMajor = dv.getUint8(24), vMinor = dv.getUint8(25);
  const headerSize = dv.getUint16(94, true);
  const offsetToData = dv.getUint32(96, true);
  const numVlrs = dv.getUint32(100, true);
  const pdrfRaw = dv.getUint8(104);
  const compressed = (pdrfRaw & 0x80) !== 0;
  const pdrf = pdrfRaw & 0x3f;
  const pdrl = dv.getUint16(105, true);
  let count = dv.getUint32(107, true);
  const scale = [dv.getFloat64(131, true), dv.getFloat64(139, true), dv.getFloat64(147, true)];
  const offset = [dv.getFloat64(155, true), dv.getFloat64(163, true), dv.getFloat64(171, true)];
  const maxs = [dv.getFloat64(179, true), dv.getFloat64(195, true), dv.getFloat64(211, true)];
  const mins = [dv.getFloat64(187, true), dv.getFloat64(203, true), dv.getFloat64(219, true)];
  if (vMajor === 1 && vMinor >= 4) {
    const ext = Number(dv.getBigUint64(247, true));
    if (ext > 0) count = ext;
  }
  // RGB byte offset within a point record, by format
  const rgbAt = {2: 20, 3: 28, 5: 28, 7: 30, 8: 30, 10: 30}[pdrf];
  return {dv, vMajor, vMinor, headerSize, offsetToData, numVlrs, pdrf, pdrl,
          count, scale, offset, mins, maxs, compressed, rgbAt};
}

function readEpsg(h) {
  // walk the VLRs looking for the GeoTIFF key directory or a WKT string
  let p = h.headerSize;
  for (let i = 0; i < h.numVlrs; i++) {
    if (p + 54 > h.dv.byteLength) break;
    let uid = '';
    for (let k = 0; k < 16; k++) {
      const c = h.dv.getUint8(p + 2 + k);
      if (c) uid += String.fromCharCode(c);
    }
    const recId = h.dv.getUint16(p + 18, true);
    const len = h.dv.getUint16(p + 20, true);
    const body = p + 54;
    if (uid.startsWith('LASF_Projection')) {
      if (recId === 34735) {                       // GeoKeyDirectory
        const n = h.dv.getUint16(body + 6, true);
        for (let k = 0; k < n; k++) {
          const o = body + 8 + k * 8;
          const keyId = h.dv.getUint16(o, true);
          const value = h.dv.getUint16(o + 6, true);
          if (keyId === 3072 && value > 0 && value < 32767) return value;   // Projected CS
          if (keyId === 2048 && value > 0 && value < 32767) return value;   // Geographic CS
        }
      }
      if (recId === 2112) {                          // WKT
        let s = '';
        for (let k = 0; k < len; k++) s += String.fromCharCode(h.dv.getUint8(body + k));
        const m = s.match(/(?:AUTHORITY|ID)\s*\[\s*"EPSG"\s*,\s*"?(\d+)/i);
        if (m) return parseInt(m[1], 10);
      }
    }
    p = body + len;
  }
  return null;
}

// ---------------------------------------------------------------- point read

function readUncompressed(h, buf, keepEvery) {
  const total = Math.ceil(h.count / keepEvery);
  const origin = h.mins.slice();
  const pos = new Float32Array(total * 3);
  const col = h.rgbAt ? new Uint8Array(total * 3) : null;
  const dv = h.dv;
  let j = 0;
  for (let i = 0; i < h.count; i += keepEvery) {
    const o = h.offsetToData + i * h.pdrl;
    if (o + h.pdrl > dv.byteLength) break;
    pos[j * 3] = dv.getInt32(o, true) * h.scale[0] + h.offset[0] - origin[0];
    pos[j * 3 + 1] = dv.getInt32(o + 4, true) * h.scale[1] + h.offset[1] - origin[1];
    pos[j * 3 + 2] = dv.getInt32(o + 8, true) * h.scale[2] + h.offset[2] - origin[2];
    if (col) {
      let r = dv.getUint16(o + h.rgbAt, true);
      let g = dv.getUint16(o + h.rgbAt + 2, true);
      let b = dv.getUint16(o + h.rgbAt + 4, true);
      if (r > 255 || g > 255 || b > 255) { r >>= 8; g >>= 8; b >>= 8; }
      col[j * 3] = r; col[j * 3 + 1] = g; col[j * 3 + 2] = b;
    }
    j++;
  }
  return {pos: pos.subarray(0, j * 3), col: col ? col.subarray(0, j * 3) : null,
          n: j, origin};
}

/* Decode a LAZ. laz-perf must decode every point in order, so `keepEvery`
   controls what we retain, not what we decode. `onProgress(frac)` is called
   periodically; `yieldEvery` lets the browser breathe. */
async function readCompressed(h, buf, keepEvery, LazPerf, onProgress, yieldFn) {
  const total = Math.ceil(h.count / keepEvery);
  const origin = h.mins.slice();
  const pos = new Float32Array(total * 3);
  const col = h.rgbAt ? new Uint8Array(total * 3) : null;
  const u8 = new Uint8Array(buf.buffer ? buf.buffer : buf, buf.byteOffset || 0, buf.byteLength);

  const filePtr = LazPerf._malloc(u8.byteLength);
  LazPerf.HEAPU8.set(u8, filePtr);
  const reader = new LazPerf.LASZip();
  reader.open(filePtr, u8.byteLength);
  const ptPtr = LazPerf._malloc(h.pdrl);
  // The wasm heap can grow during decoding, which detaches the old ArrayBuffer.
  // Re-bind the view whenever that happens instead of caching it once.
  let heapBuf = LazPerf.HEAPU8.buffer;
  let pv = new DataView(heapBuf, ptPtr, h.pdrl);
  const view = () => {
    const b = LazPerf.HEAPU8.buffer;
    if (b !== heapBuf) { heapBuf = b; pv = new DataView(b, ptPtr, h.pdrl); }
    return pv;
  };

  let j = 0;
  const CHUNK = 250000;
  try {
    for (let i = 0; i < h.count; i++) {
      reader.getPoint(ptPtr);
      if (i % keepEvery === 0 && j < total) {
        const pv = view();
        pos[j * 3] = pv.getInt32(0, true) * h.scale[0] + h.offset[0] - origin[0];
        pos[j * 3 + 1] = pv.getInt32(4, true) * h.scale[1] + h.offset[1] - origin[1];
        pos[j * 3 + 2] = pv.getInt32(8, true) * h.scale[2] + h.offset[2] - origin[2];
        if (col) {
          let r = pv.getUint16(h.rgbAt, true);
          let g = pv.getUint16(h.rgbAt + 2, true);
          let b = pv.getUint16(h.rgbAt + 4, true);
          if (r > 255 || g > 255 || b > 255) { r >>= 8; g >>= 8; b >>= 8; }
          col[j * 3] = r; col[j * 3 + 1] = g; col[j * 3 + 2] = b;
        }
        j++;
      }
      if (i % CHUNK === 0) {
        if (onProgress) onProgress(i / h.count);
        if (yieldFn) await yieldFn();
      }
    }
  } finally {
    reader.delete();
    LazPerf._free(ptPtr);
    LazPerf._free(filePtr);
  }
  return {pos: pos.subarray(0, j * 3), col: col ? col.subarray(0, j * 3) : null,
          n: j, origin};
}

export { readHeader, readEpsg, readUncompressed, readCompressed };
