import { describe, it, expect } from 'vitest';
import {
  clipText,
  countLines,
  decideAttachment,
  decodeUtf8Strict,
  extensionOf,
  isInlineCandidate,
  mimeOfPath,
  renderUserAttachmentNode,
} from './attachmentGate';
import type { AttachmentPolicy } from '../../config/attachment_policy';

const enc = (s: string) => new TextEncoder().encode(s);

const small: AttachmentPolicy = {
  inline: {
    extensions: ['md', 'txt', 'csv'],
    mimes: ['text/*', 'application/json'],
    maxLines: 3,
    maxBytes: 20,
    skipAboveBytes: 100,
  },
};

describe('添付の門: 候補の判定', () => {
  it('拡張子か MIME のどちらかが当たれば候補（大文字の拡張子・パスでも）', () => {
    expect(isInlineCandidate({ name: 'a.MD', size: 1 }, small)).toBe(true);
    expect(isInlineCandidate({ name: 'dir/x/a.txt', size: 1 }, small)).toBe(true);
    expect(isInlineCandidate({ name: 'a.foo', mimeType: 'text/x-foo', size: 1 }, small)).toBe(true);
    expect(isInlineCandidate({ name: 'a.foo', mimeType: 'application/json; charset=utf-8', size: 1 }, small)).toBe(
      true,
    );
    expect(isInlineCandidate({ name: 'a.png', mimeType: 'image/png', size: 1 }, small)).toBe(false);
    expect(isInlineCandidate({ name: 'a.bin', mimeType: '', size: 1 }, small)).toBe(false);
    expect(isInlineCandidate({ name: 'noext', size: 1 }, small)).toBe(false);
  });

  it('既定の方針は T-0672 で足した拡張子も候補にする', () => {
    for (const ext of ['ts', 'tsx', 'toml', 'ini', 'tsv', 'jsonl', 'csv', 'log']) {
      expect(isInlineCandidate({ name: `a.${ext}`, size: 1 })).toBe(true);
    }
    expect(isInlineCandidate({ name: 'a.pdf', mimeType: 'application/pdf', size: 1 })).toBe(false);
  });

  it('extensionOf / mimeOfPath', () => {
    expect(extensionOf('.bashrc')).toBe('');
    expect(extensionOf('a.tar.gz')).toBe('gz');
    expect(mimeOfPath('x.webp')).toBe('image/webp');
    expect(mimeOfPath('x.JPG')).toBe('image/jpeg');
    expect(mimeOfPath('x.pdf')).toBe('application/pdf');
    expect(mimeOfPath('x.md')).toBe('text/plain');
    expect(mimeOfPath('x.zip')).toBe('application/octet-stream');
  });
});

describe('添付の門: 切り詰め', () => {
  it('行数と大きさの両方が上限以内ならそのまま', () => {
    const r = clipText('a\nb\nc', small.inline);
    expect(r).toMatchObject({ text: 'a\nb\nc', totalLines: 3, totalBytes: 5, shownLines: 3, truncated: false });
  });

  it('行数の上限で切る（末尾の改行は行に数えない）', () => {
    expect(countLines('a\nb\n')).toBe(2);
    expect(countLines('')).toBe(0);
    const r = clipText('1\n2\n3\n4\n5\n', small.inline);
    expect(r).toMatchObject({ text: '1\n2\n3', totalLines: 5, shownLines: 3, truncated: true, partialLine: false });
  });

  it('バイトの上限が先に当たれば行の境で切る（UTF-8 の長さで数える）', () => {
    // 「あ」は 3 バイト。1 行目 12 バイト、2 行目で 12+1+12 = 25 > 20
    const r = clipText('ああああ\nああああ\nx', small.inline);
    expect(r).toMatchObject({ text: 'ああああ', shownLines: 1, truncated: true, partialLine: false });
  });

  it('1 行目だけで上限を超えるときは、その行を文字の途中で切らずに先頭だけ', () => {
    const r = clipText('あああああああああ', small.inline); // 27 バイト
    expect(r.partialLine).toBe(true);
    expect(r.shownLines).toBe(1);
    expect(r.text).toBe('ああああああ'); // 18 バイト（20 以内で文字の境）
    expect(enc(r.text).length).toBeLessThanOrEqual(20);
  });
});

describe('添付の門: 経路の決定', () => {
  it('候補でなければ media（bytes を見ない。MIME が無ければ拡張子から）', () => {
    expect(decideAttachment({ name: 'a.png', mimeType: 'image/png', size: 9 }, null, small)).toEqual({
      route: 'media',
      mimeType: 'image/png',
    });
    expect(decideAttachment({ name: 'a.pdf', mimeType: '', size: 9 }, null, small)).toEqual({
      route: 'media',
      mimeType: 'application/pdf',
    });
  });

  it('候補で UTF-8 なら inline（切り詰めつき）', () => {
    const d = decideAttachment({ name: 'a.md', size: 3, mimeType: 'text/markdown' }, enc('# h'), small);
    expect(d.route).toBe('inline');
    if (d.route === 'inline') expect(d.clip.text).toBe('# h');
  });

  it('大きすぎる候補は reference（中身を読まない）。UTF-8 でない候補も reference', () => {
    const big = decideAttachment({ name: 'a.csv', size: 101 }, null, small);
    expect(big).toMatchObject({ route: 'reference', reason: 'too_large', size: 101 });
    const sjis = decideAttachment({ name: 'a.txt', size: 2 }, new Uint8Array([0x82, 0xa0]), small);
    expect(sjis).toMatchObject({ route: 'reference', reason: 'not_utf8', size: 2 });
    expect(decodeUtf8Strict(new Uint8Array([0x82, 0xa0]))).toBeNull();
    expect(decodeUtf8Strict(enc('ok'))).toBe('ok');
    const none = decideAttachment({ name: 'a.txt', size: 2 }, null, small);
    expect(none).toMatchObject({ route: 'reference', reason: 'unreadable' });
    // 名前は csv でも中身が zip（xlsx）なら binary。NUL を含むものも
    const zip = decideAttachment({ name: 'a.csv', size: 4 }, new Uint8Array([0x50, 0x4b, 0x03, 0x04]), small);
    expect(zip).toMatchObject({ route: 'reference', reason: 'binary' });
    const nul = decideAttachment({ name: 'a.txt', size: 3 }, new Uint8Array([0x61, 0x00, 0x62]), small);
    expect(nul).toMatchObject({ route: 'reference', reason: 'binary' });
  });
});

describe('添付の門: 履歴に置く文', () => {
  const file = { name: 'memo.md', path: 'system/temp/sessions/s1/1_memo.md' };

  it('inline（切っていない）は従来と同じ形に lines / bytes が付く', () => {
    const d = decideAttachment({ name: 'memo.md', size: 5 }, enc('a\nb\nc'), small);
    const s = renderUserAttachmentNode(d, file, small);
    expect(s).toBe(
      `<user_attachment name="memo.md" path="${file.path}" lines="3" bytes="5">\na\nb\nc\n</user_attachment>`,
    );
  });

  it('切ったときは shown / truncated と、続きを read で読む注記', () => {
    const d = decideAttachment({ name: 'memo.md', size: 9 }, enc('1\n2\n3\n4\n5'), small);
    const s = renderUserAttachmentNode(d, file, small);
    expect(s).toContain('lines="5"');
    expect(s).toContain('shown="1-3"');
    expect(s).toContain('truncated="true"');
    expect(s).toContain('\n1\n2\n3\n[Truncated: showing lines 1-3 of 5');
    expect(s).toContain('<read start="4">');
    expect(s.startsWith('<user_attachment name="memo.md" path=')).toBe(true);
  });

  it('reference は中身を置かず、理由と大きさだけ', () => {
    const big = renderUserAttachmentNode(decideAttachment({ name: 'a.csv', size: 101 }, null, small), file, small);
    expect(big).toContain('[Text file not expanded: 101 B exceeds the inline limit of 100 B');
    expect(big).toContain('bytes="101"');
    expect(big).not.toContain('lines=');
    const sjis = renderUserAttachmentNode(
      decideAttachment({ name: 'a.txt', size: 2 }, new Uint8Array([0x82, 0xa0]), small),
      file,
      small,
    );
    expect(sjis).toContain('not valid UTF-8');
  });

  it('media は従来の注記のまま', () => {
    const d = decideAttachment({ name: 'a.png', mimeType: 'image/png', size: 9 }, null, small);
    expect(renderUserAttachmentNode(d, { name: 'a.png', path: 'p/a.png' })).toBe(
      '<user_attachment name="a.png" path="p/a.png">[Binary File: a.png]</user_attachment>',
    );
  });
});
