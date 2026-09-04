import { describe, it, expect } from 'vitest';
import { renderMarkdownLite } from './markdownLite';

/**
 * 入力は「HTMLエスケープ済み」であることが契約なので、
 * テストでもエスケープ後の文字列を渡す。
 */
describe('renderMarkdownLite', () => {
  it('強調を <strong> にする', () => {
    const html = renderMarkdownLite('これは **重要** です。');
    expect(html).toContain('<strong class="font-bold">重要</strong>');
  });

  it('箇条書きを <ul> にまとめる', () => {
    const html = renderMarkdownLite('- 一つ目\n- 二つ目');
    expect(html).toContain('list-disc');
    expect((html.match(/<li/g) || []).length).toBe(2);
    expect((html.match(/<ul/g) || []).length).toBe(1);
  });

  it('番号付きリストを <ol> にまとめる', () => {
    const html = renderMarkdownLite('1. 一つ目\n2. 二つ目');
    expect(html).toContain('list-decimal');
    expect((html.match(/<ol/g) || []).length).toBe(1);
  });

  it('見出しの階層を h1..h3 に丸める', () => {
    expect(renderMarkdownLite('# 見出し')).toContain('<h1');
    expect(renderMarkdownLite('## 見出し')).toContain('<h2');
    expect(renderMarkdownLite('###### 深い見出し')).toContain('<h3');
  });

  it('インラインコードを <code> にし、その中の ** を強調に変えない', () => {
    const html = renderMarkdownLite('設定は `a ** b` です。');
    expect(html).toContain('<code');
    expect(html).not.toContain('<strong');
  });

  it('【重要】コードフェンスの中身を箇条書き・見出しとして誤爆させない', () => {
    const src = ['```', '- これはコードであってリストではない', '# これも見出しではない', '```'].join('\n');
    const html = renderMarkdownLite(src);
    expect(html).toContain('<pre');
    expect(html).not.toContain('<li');
    expect(html).not.toContain('<h1');
    expect(html).toContain('- これはコードであってリストではない');
  });

  it('コードフェンスの言語指定を class に落とす', () => {
    const html = renderMarkdownLite('```ts\nconst a = 1;\n```');
    expect(html).toContain('language-ts');
  });

  it('GFMの表を <table> に変換する', () => {
    const src = ['| A | B |', '| :-- | :-- |', '| 1 | 2 |'].join('\n');
    const html = renderMarkdownLite(src);
    expect(html).toContain('<table');
    expect(html).toContain('<th');
  });

  it('空行で段落を分ける', () => {
    const html = renderMarkdownLite('一段落目。\n\n二段落目。');
    expect((html.match(/<p/g) || []).length).toBe(2);
  });

  it('段落内の改行は <br> にする', () => {
    const html = renderMarkdownLite('一行目\n二行目');
    expect((html.match(/<p/g) || []).length).toBe(1);
    expect(html).toContain('<br />');
  });

  it('リストの直後に続く通常行はリスト項目の折り返しとして扱う', () => {
    const html = renderMarkdownLite('- 項目\n  折り返し');
    expect((html.match(/<li/g) || []).length).toBe(1);
    expect(html).toContain('項目 折り返し');
  });

  it('空文字は空文字を返す', () => {
    expect(renderMarkdownLite('')).toBe('');
  });

  it('ブロック要素を返すので pre-wrap 用の生改行を残さない', () => {
    const html = renderMarkdownLite('あ\n\nい');
    expect(html.includes('\n')).toBe(false);
  });

  describe('リンク（T-0344）', () => {
    it('http(s) は外部リンク（新しいタブ）', () => {
      const html = renderMarkdownLite('[公式](https://example.com/a?b=1&amp;c=2)');
      expect(html).toContain('href="https://example.com/a?b=1&amp;c=2"');
      expect(html).toContain('target="_blank"');
      expect(html).not.toContain('data-vfs-link');
    });

    it('それ以外は VFS のパスとして data-vfs-link を付け、先頭の / は剥がす', () => {
      const html = renderMarkdownLite('結果は [見積.xlsx](/個人/資料/見積.xlsx) です');
      expect(html).toContain('data-vfs-link="個人/資料/見積.xlsx"');
      expect(html).toContain('>見積.xlsx</a>');
      expect(html).toContain('href="#"');
    });

    it('箇条書きの中でも効く。強調と混ざっても壊れない', () => {
      const html = renderMarkdownLite('- **[a](data/a.md)** を見る');
      expect(html).toContain('<strong class="font-bold"><a href="#" data-vfs-link="data/a.md"');
    });

    it('引用符は属性に入れる前に落とす', () => {
      const html = renderMarkdownLite('[x](data/a"b.md)');
      expect(html).toContain('data-vfs-link="data/a&quot;b.md"');
    });

    it('インラインコードの中の [x](y) はリンクにしない', () => {
      const html = renderMarkdownLite('`[x](y)`');
      expect(html).not.toContain('<a ');
    });
  });
});
