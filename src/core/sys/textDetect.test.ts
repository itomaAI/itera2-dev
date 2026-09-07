/**
 * src/core/sys/textDetect.test.ts
 * ホストのエディタで開くか・ビューワー（ダウンロード）へ回すかの判定（T-0389）。
 *
 * 守りたいこと:
 *   - xlsm / xlsx / pdf / png / xls（OLE）など、関連付けの無いバイナリはテキストと言わない
 *   - UTF-8 の日本語・Shift_JIS の csv・改行だけ・空 はテキスト（エディタで開ける）
 *   - 判定は先頭のバイト列だけで決まる（VFS も名前も要らない）
 */
import { describe, it, expect } from 'vitest';
import { isProbablyText, sniffBinaryKind, TEXT_SNIFF_BYTES } from './textDetect';

const bytes = (...xs: (number | string)[]) => {
  const out: number[] = [];
  for (const x of xs) {
    if (typeof x === 'string') out.push(...new TextEncoder().encode(x));
    else out.push(x);
  }
  return Uint8Array.from(out);
};

describe('sniffBinaryKind', () => {
  it('zip（xlsm / xlsx / docx）・PDF・PNG・JPEG・OLE（xls）・gzip・mp4 を見分ける', () => {
    expect(sniffBinaryKind(bytes(0x50, 0x4b, 0x03, 0x04, 0x14, 0x00))).toBe('zip');
    expect(sniffBinaryKind(bytes('%PDF-1.7\n'))).toBe('pdf');
    expect(sniffBinaryKind(bytes(0x89, 'PNG\r\n', 0x1a, 0x0a))).toBe('png');
    expect(sniffBinaryKind(bytes(0xff, 0xd8, 0xff, 0xe0))).toBe('jpeg');
    expect(sniffBinaryKind(bytes(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1))).toBe('ole');
    expect(sniffBinaryKind(bytes(0x1f, 0x8b, 0x08))).toBe('gzip');
    expect(sniffBinaryKind(bytes(0x00, 0x00, 0x00, 0x18, 'ftypmp42'))).toBe('mp4');
    expect(sniffBinaryKind(bytes('hello'))).toBeNull();
    expect(sniffBinaryKind(bytes())).toBeNull();
  });
});

describe('isProbablyText', () => {
  it('テキスト: 空・改行だけ・UTF-8 の日本語・BOM 付き UTF-8・Shift_JIS の csv・タブ区切り', () => {
    expect(isProbablyText(bytes())).toBe(true);
    expect(isProbablyText(bytes('\n\n'))).toBe(true);
    expect(isProbablyText(bytes('品名,数量\n配管,3\n'))).toBe(true);
    expect(isProbablyText(bytes(0xef, 0xbb, 0xbf, '# 見出し\n'))).toBe(true);
    // Shift_JIS の「品名,数量」（UTF-8 としては不正だが NUL は無い）
    expect(isProbablyText(bytes(0x95, 0x69, 0x96, 0xbc, 0x2c, 0x90, 0x94, 0x97, 0xca, 0x0d, 0x0a))).toBe(true);
    expect(isProbablyText(bytes('a\tb\tc\r\n'))).toBe(true);
  });

  it('バイナリ: xlsm（zip）・PDF・PNG・xls（OLE）・NUL を含む・UTF-16 の BOM', () => {
    expect(isProbablyText(bytes(0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x06, 0x00))).toBe(false);
    expect(isProbablyText(bytes('%PDF-1.4\n%', 0xe2, 0xe3, 0xcf, 0xd3))).toBe(false);
    expect(isProbablyText(bytes(0x89, 'PNG\r\n', 0x1a, 0x0a))).toBe(false);
    expect(isProbablyText(bytes(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1))).toBe(false);
    expect(isProbablyText(bytes('abc', 0x00, 'def'))).toBe(false);
    expect(isProbablyText(bytes(0xff, 0xfe, 'a', 0x00, 'b', 0x00))).toBe(false);
  });

  it('見るのは先頭 TEXT_SNIFF_BYTES だけ（その先の NUL は見ない）', () => {
    const b = new Uint8Array(TEXT_SNIFF_BYTES + 10).fill(0x41);
    b[TEXT_SNIFF_BYTES + 5] = 0;
    expect(isProbablyText(b)).toBe(true);
    b[TEXT_SNIFF_BYTES - 1] = 0;
    expect(isProbablyText(b)).toBe(false);
  });
});
