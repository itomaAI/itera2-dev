/**
 * src/core/sys/textDetect.ts
 * 「ホストのエディタで開けるテキストか」を中身から判定する（T-0389）。
 *
 * 経緯: xlsm のように関連付けの無いバイナリが名前だけの判定をすり抜け、Monaco に zip の中身が出た。
 * 名前（拡張子）の一覧は増やしても漏れるので、開く直前に先頭のバイト列を見る。
 *
 * 規則（git の「先頭 8000 バイトに NUL があればバイナリ」を基本にし、既知の magic で早く決める）:
 *   1. 空 → テキスト（新しいファイルはエディタで開いてよい）
 *   2. 既知の magic（zip / PDF / PNG / JPEG / GIF / RIFF / OLE / ELF / EXE / gzip / bzip2 / 7z / RAR / wasm / SQLite / フォント / mp4 / ogg / flac / mp3）→ バイナリ
 *   3. UTF-16 の BOM → バイナリ扱い（中身はテキストだが、エディタは UTF-8 でしか読まないので壊れて見える）
 *   4. 先頭 8000 バイトに NUL（0x00）→ バイナリ
 *   5. それ以外 → テキスト（UTF-8 でなくてもよい。Shift_JIS の csv/txt は NUL を含まない）
 *
 * 純粋関数。VFS にも DOM にも依らない（試験はバイト列だけで書ける）。
 */

export const TEXT_SNIFF_BYTES = 8000;

const MAGICS: Array<{ kind: string; at?: number; bytes: number[] }> = [
  { kind: 'zip', bytes: [0x50, 0x4b, 0x03, 0x04] }, // PK.. — xlsx / xlsm / docx / pptx / jar / apk も
  { kind: 'zip', bytes: [0x50, 0x4b, 0x05, 0x06] }, // 空の zip
  { kind: 'pdf', bytes: [0x25, 0x50, 0x44, 0x46] }, // %PDF
  { kind: 'png', bytes: [0x89, 0x50, 0x4e, 0x47] },
  { kind: 'jpeg', bytes: [0xff, 0xd8, 0xff] },
  { kind: 'gif', bytes: [0x47, 0x49, 0x46, 0x38] }, // GIF8
  { kind: 'riff', bytes: [0x52, 0x49, 0x46, 0x46] }, // RIFF — webp / wav / avi
  { kind: 'ole', bytes: [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1] }, // xls / doc / ppt / msi
  { kind: 'elf', bytes: [0x7f, 0x45, 0x4c, 0x46] },
  { kind: 'exe', bytes: [0x4d, 0x5a] }, // MZ
  { kind: 'gzip', bytes: [0x1f, 0x8b] },
  { kind: 'bzip2', bytes: [0x42, 0x5a, 0x68] }, // BZh
  { kind: '7z', bytes: [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c] },
  { kind: 'rar', bytes: [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07] },
  { kind: 'wasm', bytes: [0x00, 0x61, 0x73, 0x6d] },
  { kind: 'sqlite', bytes: [0x53, 0x51, 0x4c, 0x69, 0x74, 0x65, 0x20, 0x66] }, // SQLite f
  { kind: 'woff', bytes: [0x77, 0x4f, 0x46, 0x46] }, // wOFF
  { kind: 'woff2', bytes: [0x77, 0x4f, 0x46, 0x32] }, // wOF2
  { kind: 'otf', bytes: [0x4f, 0x54, 0x54, 0x4f] }, // OTTO
  { kind: 'ttf', bytes: [0x00, 0x01, 0x00, 0x00] },
  { kind: 'mp4', at: 4, bytes: [0x66, 0x74, 0x79, 0x70] }, // ....ftyp
  { kind: 'ogg', bytes: [0x4f, 0x67, 0x67, 0x53] }, // OggS
  { kind: 'flac', bytes: [0x66, 0x4c, 0x61, 0x43] }, // fLaC
  { kind: 'mp3', bytes: [0x49, 0x44, 0x33] }, // ID3
];

/** 既知のバイナリの magic に当たれば種類の名前、当たらなければ null。 */
export function sniffBinaryKind(bytes: Uint8Array): string | null {
  for (const m of MAGICS) {
    const at = m.at ?? 0;
    if (bytes.length < at + m.bytes.length) continue;
    let hit = true;
    for (let i = 0; i < m.bytes.length; i++) {
      if (bytes[at + i] !== m.bytes[i]) {
        hit = false;
        break;
      }
    }
    if (hit) return m.kind;
  }
  return null;
}

/** ホストのエディタ（UTF-8 のテキスト）で開いてよいか。先頭の TEXT_SNIFF_BYTES だけ見る。 */
export function isProbablyText(bytes: Uint8Array): boolean {
  if (bytes.length === 0) return true;
  if (sniffBinaryKind(bytes) !== null) return false;
  // UTF-16 の BOM: 中身は文字だが、エディタは UTF-8 で読むので壊れて見える → ここでは開かない
  if (bytes.length >= 2 && ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff)))
    return false;
  const n = Math.min(bytes.length, TEXT_SNIFF_BYTES);
  for (let i = 0; i < n; i++) if (bytes[i] === 0) return false;
  return true;
}
