/**
 * tests/guest/pdfExtract.test.ts
 * pdf_extract（system/services/pdf_tool.html）の土台 — pdf-lib の copyPages で切り出した PDF が
 * 「元のページの文字層を持ったまま」であること（T-0687）。
 *
 * 守りたいこと:
 *   - 切り出した PDF は指定したページだけを持つ（順も指定どおり）
 *   - 文字層が残る: pdf.js で読むと元の文字がそのまま出る（画像にすると落ちる情報。この道具の存在理由）
 *   - 暗号化された PDF は断る（黙って壊れた写しを作らない）
 *
 * デーモンの中の手順（load → parsePages → copyPages → addPage → save）をそのまま node で踏む。
 * ゲストの JS は jsdom では動かないので、同じライブラリを同じ順で呼ぶ。
 */
import { describe, it, expect } from 'vitest';
import { PDFDocument, StandardFonts } from '@cantoo/pdf-lib';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(__dirname, '../../');
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function loadLib(): any {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mod: any = { exports: {} };
  new Function('module', readFileSync(resolve(ROOT, 'vfs_root/system/lib/pdf_text.js'), 'utf8'))(mod);
  return mod.exports;
}
const P = loadLib();

async function makeSource(words: string[]): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const w of words) {
    const page = doc.addPage([300, 200]);
    page.drawText(w, { x: 20, y: 100, size: 24, font });
  }
  doc.setTitle('source');
  return doc.save();
}

/** デーモンの extract と同じ手順 */
async function extract(src: Uint8Array, spec: string): Promise<{ bytes: Uint8Array; pages: number[] }> {
  const s = await PDFDocument.load(src, { ignoreEncryption: false, updateMetadata: false });
  const pages: number[] = P.parsePages(spec, s.getPageCount());
  const d = await PDFDocument.create();
  const copied = await d.copyPages(
    s,
    pages.map((i) => i - 1),
  );
  for (const pg of copied) d.addPage(pg);
  return { bytes: await d.save({ useObjectStreams: true }), pages };
}

async function textOf(bytes: Uint8Array): Promise<string[]> {
  // pdf.js の node 向けの束。worker は無し（fake worker）
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = pdfjs.getDocument({
    data: bytes,
    standardFontDataUrl: resolve(ROOT, 'node_modules/pdfjs-dist/standard_fonts') + '/',
  });
  const doc = await task.promise;
  const out: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    out.push(content.items.map((it) => ('str' in it ? it.str : '')).join(''));
  }
  await task.destroy(); // destroy は loadingTask にある（doc には無い）
  return out;
}

describe('pdf_extract の土台（pdf-lib の copyPages）', () => {
  it('指定したページだけを持ち、文字層が残る', async () => {
    const src = await makeSource(['ALPHA', 'BRAVO', 'CHARLIE', 'DELTA']);
    const { bytes, pages } = await extract(src, '2-3');
    expect(pages).toEqual([2, 3]);
    const d = await PDFDocument.load(bytes);
    expect(d.getPageCount()).toBe(2);
    expect(await textOf(bytes)).toEqual(['BRAVO', 'CHARLIE']);
    expect(bytes.length).toBeLessThan(src.length + 1024); // 元より大きくはならない（フォントは写しが 1 つ）
  });
  it('飛び飛びの指定は昇順に', async () => {
    const src = await makeSource(['ALPHA', 'BRAVO', 'CHARLIE', 'DELTA']);
    const { bytes } = await extract(src, '4,1');
    expect(await textOf(bytes)).toEqual(['ALPHA', 'DELTA']);
  });
  it('範囲外は断る（詰めない）', async () => {
    const src = await makeSource(['ALPHA', 'BRAVO']);
    await expect(extract(src, '3')).rejects.toThrow(/範囲外/);
  });
  it('暗号化された PDF は断る', async () => {
    // 暗号化の印だけを持つ最小の PDF（本文は無い）。pdf-lib は ignoreEncryption:false なら load で投げる
    const encrypted = new TextEncoder().encode(
      '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[]/Count 0>>endobj\n' +
        '3 0 obj<</Filter/Standard/V 1/R 2/O(x)/U(y)/P -1>>endobj\n' +
        'trailer<</Root 1 0 R/Encrypt 3 0 R/ID[<a><b>]>>\n%%EOF',
    );
    await expect(PDFDocument.load(encrypted, { ignoreEncryption: false })).rejects.toThrow(/encrypt/i);
  });
});
