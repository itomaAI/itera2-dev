/**
 * system/lib/zip_core.js — zip の形式の部品（T-0712）
 *
 * 純粋な部品。VFS も画面も触らない。読むのはデーモン system/services/zip_tool.html と、
 * 試験 tests/guest/zipTool.test.ts（この実ファイルを評価する。コピーしない）。
 *
 * 扱うもの:
 *   - ローカルヘッダ・central directory・EOCD（読み・書き）
 *   - 圧縮方式 0（store）と 8（deflate。inflateRaw / deflateRaw は DecompressionStream / CompressionStream）
 *   - 名前の符号: UTF-8 旗（bit 11）・Info-ZIP Unicode Path（extra 0x7075）。旗の無い名前は
 *     ASCII → UTF-8（厳密）→ 既定の符号（cp932。Windows の「送る → 圧縮」の zip）の順に読む
 *   - data descriptor（bit 3）の項目（大きさは central directory から取る）
 * 扱わないもの:
 *   - zip64（4 GB 超・65,535 項目超・中央目録の位置が 32 bit に収まらない）→ 断る
 *   - 暗号化（bit 0）→ 項目ごとに断る
 *   - 分割（spanned / multi-disk）
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.ZipCore = api;
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  const SIG_LOCAL = 0x04034b50;
  const SIG_CENTRAL = 0x02014b50;
  const SIG_EOCD = 0x06054b50;
  const SIG_EOCD64_LOCATOR = 0x07064b50;
  const FLAG_ENCRYPTED = 0x0001;
  const FLAG_UTF8 = 0x0800;
  const METHOD_STORE = 0;
  const METHOD_DEFLATE = 8;
  const MAX32 = 0xffffffff;
  const MAX16 = 0xffff;
  const DEFAULT_FALLBACK = 'shift_jis';

  const u16 = (b, o) => b[o] | (b[o + 1] << 8);
  const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
  const w16 = (dv, o, v) => dv.setUint16(o, v & MAX16, true);
  const w32 = (dv, o, v) => dv.setUint32(o, v >>> 0, true);

  // ---- CRC-32 (IEEE) ----
  const TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();
  function crc32(u8, seed) {
    let c = (seed === undefined ? 0 : seed) ^ 0xffffffff;
    for (let i = 0; i < u8.length; i++) c = TABLE[(c ^ u8[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  // ---- 日時（MS-DOS の 2 秒刻み・ローカル時刻） ----
  function dosToDate(time, date) {
    const y = ((date >> 9) & 0x7f) + 1980;
    const mo = ((date >> 5) & 0x0f) - 1;
    const d = date & 0x1f;
    const h = (time >> 11) & 0x1f;
    const mi = (time >> 5) & 0x3f;
    const s = (time & 0x1f) * 2;
    return new Date(y, mo, d || 1, h, mi, s);
  }
  function dateToDos(value) {
    const d = value instanceof Date ? value : new Date(value || Date.now());
    const y = Math.min(Math.max(d.getFullYear(), 1980), 2107);
    const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
    const date = ((y - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    return { time, date };
  }

  // ---- extra field ----
  function parseExtra(extra) {
    const out = [];
    let p = 0;
    while (p + 4 <= extra.length) {
      const id = u16(extra, p);
      const len = u16(extra, p + 2);
      if (p + 4 + len > extra.length) break;
      out.push({ id, data: extra.subarray(p + 4, p + 4 + len) });
      p += 4 + len;
    }
    return out;
  }

  // ---- 名前の復号 ----
  const isAscii = (b) => {
    for (let i = 0; i < b.length; i++) if (b[i] > 0x7e || b[i] < 0x20) return false;
    return true;
  };
  function decoder(label, fatal) {
    try {
      return new TextDecoder(label, { fatal: !!fatal });
    } catch (e) {
      throw new Error('Unknown encoding: ' + label);
    }
  }
  /**
   * @param {Uint8Array} nameBytes
   * @param {number} flags
   * @param {Uint8Array} extra
   * @param {{encoding?: string}} [opts] encoding: 旗の無い名前に使う符号（既定 shift_jis）。"utf-8" を渡すと cp932 を試さない
   * @returns {{ name: string, encoding: string }} encoding は実際に使った符号（"utf-8" / "ascii" / "shift_jis" …）
   */
  function decodeName(nameBytes, flags, extra, opts) {
    const fallback = (opts && opts.encoding) || DEFAULT_FALLBACK;
    // Info-ZIP Unicode Path: version(1) crc32(4) utf8 name。元の名前の CRC が合うときだけ信じる
    for (const f of parseExtra(extra || new Uint8Array(0))) {
      if (f.id !== 0x7075 || f.data.length < 5 || f.data[0] !== 1) continue;
      if (u32(f.data, 1) !== crc32(nameBytes)) continue;
      return { name: decoder('utf-8').decode(f.data.subarray(5)), encoding: 'utf-8' };
    }
    if (flags & FLAG_UTF8) return { name: decoder('utf-8').decode(nameBytes), encoding: 'utf-8' };
    if (isAscii(nameBytes)) return { name: decoder('utf-8').decode(nameBytes), encoding: 'ascii' };
    if (fallback !== 'utf-8' && fallback !== 'utf8') {
      try {
        return { name: decoder('utf-8', true).decode(nameBytes), encoding: 'utf-8' };
      } catch (e) {
        /* UTF-8 として読めない → 既定の符号 */
      }
      return { name: decoder(fallback).decode(nameBytes), encoding: fallback };
    }
    return { name: decoder('utf-8').decode(nameBytes), encoding: 'utf-8' };
  }

  // ---- central directory ----
  function findEocd(b) {
    const min = Math.max(0, b.length - (MAX16 + 22));
    for (let i = b.length - 22; i >= min; i--) {
      if (u32(b, i) === SIG_EOCD) return i;
    }
    return -1;
  }
  /**
   * @param {Uint8Array} b zip 全体
   * @param {{encoding?: string}} [opts]
   * @returns {{ entries: Array<object>, comment: string, encodings: Record<string, number> }}
   *   entries[i] = { index, name, dir, method, flags, encrypted, crc, csize, usize, offset, mtime, encoding, extra }
   */
  function readCentralDirectory(b, opts) {
    if (!b || b.length < 22) throw new Error('Not a zip file (too small)');
    const eocd = findEocd(b);
    if (eocd < 0) throw new Error('Not a zip file (end of central directory not found; corrupt or not a zip)');
    if (eocd >= 20 && u32(b, eocd - 20) === SIG_EOCD64_LOCATOR)
      throw new Error('Zip64 is not supported (archives over 4 GB or 65,535 entries)');
    const diskNo = u16(b, eocd + 4);
    const cdDisk = u16(b, eocd + 6);
    if (diskNo !== 0 || cdDisk !== 0) throw new Error('Spanned (multi-part) archives are not supported');
    const count = u16(b, eocd + 10);
    const cdSize = u32(b, eocd + 12);
    const cdOffset = u32(b, eocd + 16);
    if (count === MAX16 || cdOffset === MAX32 || cdSize === MAX32)
      throw new Error('Zip64 is not supported (archives over 4 GB or 65,535 entries)');
    if (cdOffset + cdSize > eocd) throw new Error('Corrupt zip: central directory is outside the file');
    const commentLen = u16(b, eocd + 20);
    const comment = decoder('utf-8').decode(b.subarray(eocd + 22, eocd + 22 + commentLen));
    const entries = [];
    const encodings = {};
    let p = cdOffset;
    for (let i = 0; i < count; i++) {
      if (p + 46 > eocd || u32(b, p) !== SIG_CENTRAL)
        throw new Error('Corrupt zip: bad central directory entry #' + (i + 1));
      const flags = u16(b, p + 8);
      const method = u16(b, p + 10);
      const time = u16(b, p + 12);
      const date = u16(b, p + 14);
      const crc = u32(b, p + 16);
      const csize = u32(b, p + 20);
      const usize = u32(b, p + 24);
      const nlen = u16(b, p + 28);
      const elen = u16(b, p + 30);
      const clen = u16(b, p + 32);
      const external = u32(b, p + 38);
      const offset = u32(b, p + 42);
      const nameBytes = b.subarray(p + 46, p + 46 + nlen);
      const extra = b.subarray(p + 46 + nlen, p + 46 + nlen + elen);
      if (csize === MAX32 || usize === MAX32 || offset === MAX32)
        throw new Error('Zip64 is not supported (entry #' + (i + 1) + ' is over 4 GB)');
      const dn = decodeName(nameBytes, flags, extra, opts);
      const dir = dn.name.endsWith('/') || (external & 0x10) !== 0 || (external >>> 16) & 0x4000 ? true : false;
      entries.push({
        index: i,
        name: dn.name,
        dir: dir && usize === 0,
        method,
        flags,
        encrypted: (flags & FLAG_ENCRYPTED) !== 0,
        crc,
        csize,
        usize,
        offset,
        mtime: dosToDate(time, date),
        encoding: dn.encoding,
        extra,
      });
      encodings[dn.encoding] = (encodings[dn.encoding] || 0) + 1;
      p += 46 + nlen + elen + clen;
    }
    return { entries, comment, encodings };
  }

  /** 項目の圧縮済みデータの範囲（ローカルヘッダを読んで位置を確かめる） */
  function localDataRange(b, entry) {
    const o = entry.offset;
    if (o + 30 > b.length || u32(b, o) !== SIG_LOCAL)
      throw new Error('Corrupt zip: bad local header for ' + entry.name);
    const nlen = u16(b, o + 26);
    const elen = u16(b, o + 28);
    const start = o + 30 + nlen + elen;
    const end = start + entry.csize;
    if (end > b.length) throw new Error('Corrupt zip: data of ' + entry.name + ' runs past the end of the file');
    return { start, end };
  }

  // ---- deflate（ブラウザ標準の stream。Node 21.2+ も同じ） ----
  async function pipe(stream, bytes) {
    const w = stream.writable.getWriter();
    const writing = w.write(bytes).then(() => w.close());
    const buf = await new Response(stream.readable).arrayBuffer();
    await writing;
    return new Uint8Array(buf);
  }
  function inflateRaw(bytes) {
    if (typeof DecompressionStream === 'undefined') throw new Error('DecompressionStream is not available');
    return pipe(new DecompressionStream('deflate-raw'), bytes);
  }
  function deflateRaw(bytes) {
    if (typeof CompressionStream === 'undefined') throw new Error('CompressionStream is not available');
    return pipe(new CompressionStream('deflate-raw'), bytes);
  }

  /** 項目の中身を取り出す（store / deflate。CRC を照合する） */
  async function extractEntry(b, entry) {
    if (entry.encrypted) throw new Error('Encrypted entry is not supported: ' + entry.name);
    const { start, end } = localDataRange(b, entry);
    const raw = b.subarray(start, end);
    let data;
    // store は写しを返す（view を返すと、受け取った側が .buffer を見たときに zip 全体に化ける。
    // 書いた直後に zip を手放せる、という意味でも写しがよい）
    if (entry.method === METHOD_STORE) data = raw.slice();
    else if (entry.method === METHOD_DEFLATE) data = await inflateRaw(raw);
    else throw new Error('Unsupported compression method ' + entry.method + ': ' + entry.name);
    if (data.length !== entry.usize)
      throw new Error('Size mismatch for ' + entry.name + ' (expected ' + entry.usize + ', got ' + data.length + ')');
    if (crc32(data) !== entry.crc) throw new Error('CRC mismatch for ' + entry.name + ' (corrupt data)');
    return data;
  }

  // ---- 名前の安全化（zip slip） ----
  /**
   * zip の中の名前を VFS の相対パスにする。危険なもの（`..`・絶対パス・ドライブ文字）は null。
   * 末尾の "/" は保つ（ディレクトリの印）。
   */
  function safeName(name) {
    if (typeof name !== 'string') return null;
    let s = name.replace(/\\/g, '/').replace(/^[A-Za-z]:/, '');
    s = s.replace(/\/{2,}/g, '/').replace(/^\/+/, '');
    const trailing = s.endsWith('/');
    const segs = s.split('/').filter((x) => x !== '' && x !== '.');
    if (!segs.length) return null;
    for (const seg of segs) if (seg === '..' || /[\0]/.test(seg)) return null;
    return segs.join('/') + (trailing ? '/' : '');
  }
  /** 先頭の n 段を落とす（tar の --strip-components）。残らなければ null */
  function stripComponents(name, n) {
    if (!n) return name;
    const trailing = name.endsWith('/');
    const segs = name.split('/').filter(Boolean);
    if (segs.length <= n) return null;
    return segs.slice(n).join('/') + (trailing ? '/' : '');
  }

  // ---- 絞り込み（glob） ----
  function parsePatterns(s) {
    if (Array.isArray(s)) return s.map((x) => String(x).trim()).filter(Boolean);
    return String(s || '')
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean);
  }
  /**
   * パターン: "**" は何でも（/ を含む）、"*" は / 以外の何文字でも、"?" は 1 文字。
   * ワイルドカードの無いパターンは「その名前そのもの」か「そのディレクトリの下」に当たる（"app" は app/x にも）。
   * 末尾が "/" ならディレクトリの下だけ。
   */
  function globToRegExp(pattern) {
    const p = pattern.replace(/\\/g, '/').replace(/^\/+/, '');
    if (!/[*?]/.test(p)) {
      const base = p.replace(/\/+$/, '');
      const esc = base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return p.endsWith('/') ? new RegExp('^' + esc + '/') : new RegExp('^' + esc + '(/|$)');
    }
    let re = '';
    for (let i = 0; i < p.length; i++) {
      const c = p[i];
      if (c === '*') {
        if (p[i + 1] === '*') {
          re += '.*';
          i++;
          if (p[i + 1] === '/') i++;
        } else re += '[^/]*';
      } else if (c === '?') re += '[^/]';
      else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
    return new RegExp('^' + re + '$');
  }
  function matchesAny(name, patterns) {
    const list = Array.isArray(patterns) ? patterns : parsePatterns(patterns);
    if (!list.length) return false;
    const n = name.replace(/\/+$/, '');
    return list.some((pt) => globToRegExp(pt).test(n) || globToRegExp(pt).test(name));
  }

  // ---- 書く ----
  /**
   * @param {Array<{name: string, data?: Uint8Array, compressed?: Uint8Array, method?: number, mtime?: Date|number}>} items
   *   name が "/" で終わればディレクトリ（data 無し）。method 8 のときは compressed（deflate-raw 済み）を渡す。
   * @returns {Uint8Array}
   */
  function buildZip(items) {
    if (!Array.isArray(items)) throw new Error('items must be an array');
    if (items.length > MAX16) throw new Error('Zip64 is not supported (more than 65,535 entries)');
    const enc = new TextEncoder();
    const parts = [];
    const central = [];
    let offset = 0;
    const push = (u8) => {
      parts.push(u8);
      offset += u8.length;
    };
    const seen = new Set();
    for (const it of items) {
      const name = safeName(it.name);
      if (!name) throw new Error('Unsafe or empty entry name: ' + it.name);
      if (seen.has(name)) throw new Error('Duplicate entry name: ' + name);
      seen.add(name);
      const isDir = name.endsWith('/');
      const data = isDir ? new Uint8Array(0) : it.data || new Uint8Array(0);
      const method = isDir ? METHOD_STORE : it.method === METHOD_DEFLATE ? METHOD_DEFLATE : METHOD_STORE;
      const body = method === METHOD_DEFLATE ? it.compressed : data;
      if (method === METHOD_DEFLATE && !(body instanceof Uint8Array))
        throw new Error('compressed bytes are required for a deflate entry: ' + name);
      if (data.length > MAX32 || body.length > MAX32)
        throw new Error('Zip64 is not supported (' + name + ' is over 4 GB)');
      const nameBytes = enc.encode(name);
      if (nameBytes.length > MAX16) throw new Error('Entry name too long: ' + name);
      const crc = crc32(data);
      const { time, date } = dateToDos(it.mtime);
      const flags = FLAG_UTF8;
      const local = new Uint8Array(30 + nameBytes.length);
      const lv = new DataView(local.buffer);
      w32(lv, 0, SIG_LOCAL);
      w16(lv, 4, 20);
      w16(lv, 6, flags);
      w16(lv, 8, method);
      w16(lv, 10, time);
      w16(lv, 12, date);
      w32(lv, 14, crc);
      w32(lv, 18, body.length);
      w32(lv, 22, data.length);
      w16(lv, 26, nameBytes.length);
      w16(lv, 28, 0);
      local.set(nameBytes, 30);
      const localOffset = offset;
      push(local);
      push(body);

      const c = new Uint8Array(46 + nameBytes.length);
      const cv = new DataView(c.buffer);
      w32(cv, 0, SIG_CENTRAL);
      w16(cv, 4, 20 | (3 << 8)); // made by: UNIX (3), spec 2.0
      w16(cv, 6, 20);
      w16(cv, 8, flags);
      w16(cv, 10, method);
      w16(cv, 12, time);
      w16(cv, 14, date);
      w32(cv, 16, crc);
      w32(cv, 20, body.length);
      w32(cv, 24, data.length);
      w16(cv, 28, nameBytes.length);
      w16(cv, 30, 0);
      w16(cv, 32, 0);
      w16(cv, 34, 0);
      w16(cv, 36, 0);
      // external attrs: 下位 8 bit は MS-DOS（0x10 = ディレクトリ）、上位 16 bit は UNIX の mode
      w32(cv, 38, isDir ? 0x10 | (0o40755 << 16) : 0o100644 << 16);
      w32(cv, 42, localOffset);
      c.set(nameBytes, 46);
      central.push(c);
    }
    const cdOffset = offset;
    for (const c of central) push(c);
    const cdSize = offset - cdOffset;
    if (offset + 22 > MAX32) throw new Error('Zip64 is not supported (archive over 4 GB)');
    const eocd = new Uint8Array(22);
    const ev = new DataView(eocd.buffer);
    w32(ev, 0, SIG_EOCD);
    w16(ev, 4, 0);
    w16(ev, 6, 0);
    w16(ev, 8, central.length);
    w16(ev, 10, central.length);
    w32(ev, 12, cdSize);
    w32(ev, 16, cdOffset);
    w16(ev, 20, 0);
    push(eocd);
    const out = new Uint8Array(offset);
    let pos = 0;
    for (const u of parts) {
      out.set(u, pos);
      pos += u.length;
    }
    return out;
  }

  function fmtSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(bytes < 10240 ? 1 : 0) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  }

  return {
    METHOD_STORE,
    METHOD_DEFLATE,
    crc32,
    dosToDate,
    dateToDos,
    parseExtra,
    decodeName,
    readCentralDirectory,
    localDataRange,
    inflateRaw,
    deflateRaw,
    extractEntry,
    safeName,
    stripComponents,
    parsePatterns,
    globToRegExp,
    matchesAny,
    buildZip,
    fmtSize,
  };
});
