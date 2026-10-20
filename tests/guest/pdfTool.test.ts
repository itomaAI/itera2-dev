/**
 * tests/guest/pdfTool.test.ts
 * PDF の道具（system/services/pdf_tool.html）と、その部品 system/lib/pdf_text.js（T-0681 → T-0686）
 *
 * 守りたいこと:
 *   - 同じ高さの断片は 1 行に、隙間の大きさで空白を入れる。y で上から並べ、行の中は x で左から
 *   - viewport の変換（y の反転・回転）を通して位置を見る（pdf.js の Util.transform と同じ積）
 *   - form="items" は y<TAB>x<TAB>文字 の 1 行ずつ
 *   - pages の指定は 1 始まりで、範囲外は詰めずに断る（「指定したページを読んだつもり」を作らない）
 *   - デーモンは pdf.js を vfs_root からではなく MetaOS.vendor.resolve('pdfjs') で引く（window.top.location を覗かない）
 *   - 常駐しない（services.json で autoStart: false）
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(__dirname, '../../');
const read = (p: string) => readFileSync(resolve(ROOT, p), 'utf8');
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function loadLib(): any {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mod: any = { exports: {} };
  new Function('module', read('vfs_root/system/lib/pdf_text.js'))(mod);
  return mod.exports;
}
const P = loadLib();
// pdf.js の既定の viewport（scale 1・回転なし・高さ 842）: y を反転して原点を左上に
const VT = [1, 0, 0, -1, 0, 842];
const item = (str: string, x: number, yUp: number, size = 10, width = str.length * size) => ({
  str,
  transform: [size, 0, 0, size, x, yUp],
  width,
  height: size,
});

describe('itemsToLines', () => {
  it('同じ高さは 1 行、隙間で空白、上から・左から', () => {
    const lines = P.itemsToLines(
      [
        item('式', 311, 760),
        item('1', 285, 760),
        item('防水工事', 50, 760),
        item('名', 100, 780),
        item('称', 180, 780),
      ],
      VT,
    );
    expect(lines).toEqual(['名   称', '防水工事   1   式']);
  });
  it('少しずつずれる y（1 文字ずつ置く PDF）も同じ行に、空白だけの断片は捨てる', () => {
    const lines = P.itemsToLines(
      [item('市', 48, 800), item('営', 57, 799.5), item(' ', 66, 800), item('住', 66, 799.2)],
      VT,
    );
    expect(lines).toEqual(['市営住']);
  });
  it('回転した viewport でも位置で並ぶ', () => {
    const rot = [0, 1, 1, 0, 0, 0];
    const lines = P.itemsToLines([item('二', 100, 50), item('一', 100, 20), item('次', 120, 20)], rot);
    expect(lines).toEqual(['一   二', '次']);
  });
  it('文字が無ければ空', () => {
    expect(P.itemsToLines([], VT)).toEqual([]);
    expect(P.renderPage(3, [])).toBe('--- p.3 ---\n（文字なし）\n');
  });
});

describe('itemsWithPositions / parseRange / transform', () => {
  it('items は y<TAB>x<TAB>文字', () => {
    expect(P.itemsWithPositions([item('b', 20, 800), item('a', 10, 800)], VT)).toEqual(['42\t10\ta', '42\t20\tb']);
  });
  it('parseRange（旧 from/to）は 1 始まりで詰める', () => {
    expect(P.parseRange(undefined, undefined, 35)).toEqual({ from: 1, to: 35 });
    expect(P.parseRange('5', '7', 35)).toEqual({ from: 5, to: 7 });
    expect(P.parseRange('0', '99', 35)).toEqual({ from: 1, to: 35 });
  });
  it('transform は行列の積（pdf.js の Util.transform）', () => {
    expect(P.transform([1, 0, 0, -1, 0, 842], [10, 0, 0, 10, 48, 800])).toEqual([10, 0, 0, -10, 48, 42]);
  });
});

describe('parsePages', () => {
  it('"3" / "3-5" / "1,4,7-9" / "-2" / "7-" / "all" を昇順・重複なしの配列に', () => {
    expect(P.parsePages('3', 10)).toEqual([3]);
    expect(P.parsePages('3-5', 10)).toEqual([3, 4, 5]);
    expect(P.parsePages('9,1,4,7-9', 10)).toEqual([1, 4, 7, 8, 9]);
    expect(P.parsePages('-2', 10)).toEqual([1, 2]);
    expect(P.parsePages('9-', 10)).toEqual([9, 10]);
    expect(P.parsePages('ALL', 3)).toEqual([1, 2, 3]);
  });
  it('範囲外・読めない指定・空は断る（詰めない）', () => {
    expect(() => P.parsePages('', 10)).toThrow(/pages/);
    expect(() => P.parsePages('0', 10)).toThrow(/範囲外/);
    expect(() => P.parsePages('11', 10)).toThrow(/1〜10/);
    expect(() => P.parsePages('5-3', 10)).toThrow(/範囲外/);
    expect(() => P.parsePages('x', 10)).toThrow(/読めない/);
    expect(() => P.parsePages('-', 10)).toThrow(/読めない/);
    expect(() => P.parsePages('1', 0)).toThrow(/ページが無い/);
  });
});

describe('置き場と配線', () => {
  it('pdf.js は vfs_root に置かず、デーモンはホストの目録（MetaOS.vendor）で引く', () => {
    expect(existsSync(resolve(ROOT, 'vfs_root/system/vendor/pdf.min.js'))).toBe(false);
    const daemon = read('vfs_root/system/services/pdf_tool.html');
    expect(daemon).toContain("MetaOS.vendor.resolve('pdfjs')".replace('MetaOS', 'M'));
    expect(daemon).not.toContain('window.top.location.href'); // ホストの配置をゲストが知らない（コメントで言及するだけ）
    expect(daemon).not.toContain('document.referrer');
    expect(daemon).toContain('<script src="/system/lib/pdf_text.js">');
    expect(read('scripts/copy_vendor.js')).toContain("put('pdfjs', 'pdfjs-dist'");
  });
  it('3 つの道具と旧名を登録し、常駐しない', () => {
    const daemon = read('vfs_root/system/services/pdf_tool.html');
    for (const n of ['pdf_info', 'pdf_pages', 'pdf_text', 'pdf_to_text']) expect(daemon).toContain(`name: '${n}'`);
    const reg = JSON.parse(read('vfs_root/system/registry/services.json'));
    expect(reg.find((s: { id: string }) => s.id === 'pdf_tool')).toMatchObject({
      autoStart: false,
      path: 'system/services/pdf_tool.html',
    });
  });
});
