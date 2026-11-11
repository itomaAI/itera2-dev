// @vitest-environment jsdom
/**
 * tests/guest/designCanvasTyping.test.ts
 * Design Canvas（`vfs_root/system/apps/design_canvas/`）の右のパネルで、文字の欄に続けて打てる（T-0810）。
 *
 * 起きていたこと: 欄に 1 文字打つ → 文書が変わる → キャンバス（editor）が「選択が変わった」を毎回知らせる
 * → パネルが欄を作り直す → 打っていた欄が消えて入力の焦点が外れる（日本語入力では 1 文字ごとに確定が走る）。
 * パネルには「打っている最中は作り直さない」の守りがあったが、選択の知らせの経路はそれを通らなかった。
 *
 * 実装をコピーせず、ソースをそのまま jsdom で動かす（言葉の表・部品・文書・キャンバス・パネルの 5 本）。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const DIR = resolve(__dirname, '../../vfs_root/system/apps/design_canvas/js');
const SOURCES = ['i18n.js', 'parts.js', 'model.js', 'editor.js', 'panel.js'].map((f) =>
  readFileSync(resolve(DIR, f), 'utf8'),
);

/* eslint-disable @typescript-eslint/no-explicit-any */
const w = window as any;

function boot() {
  document.body.innerHTML = '<main id="viewport"></main><aside id="panel"></aside>';
  for (const src of SOURCES) new Function(src)();
  const doc = w.DesignDoc.emptyDoc();
  const model = new w.DesignModel(doc);
  const editor = new w.DesignEditor(model, document.getElementById('viewport'));
  const root = document.getElementById('panel') as HTMLElement;
  const panel = new w.DesignPanel(model, editor, root);
  return { model, editor, panel, root };
}

/** 利用者が欄に打つのと同じ: 値を書いて input を出す */
function typeInto(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  el.value = value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
}
const textInputs = (root: HTMLElement) =>
  [...root.querySelectorAll('input:not([type=number]), textarea')] as Array<HTMLInputElement | HTMLTextAreaElement>;

describe('Design Canvas: text fields keep the focus while typing (T-0810)', () => {
  let app: ReturnType<typeof boot>;
  let partId: string;
  beforeEach(() => {
    app = boot();
    const sid = app.model.doc.screens[0].id;
    partId = app.model.addPart(sid, 'button', { x: 40, y: 40 });
  });

  it('design fields (nothing selected): the field is not rebuilt on each keystroke', () => {
    app.editor.select([]);
    const input = textInputs(app.root)[0];
    input.focus();
    for (const v of ['け', 'けい', '経費']) {
      typeInto(input, v);
      expect(input.isConnected, v).toBe(true);
      expect(document.activeElement, v).toBe(input);
    }
    expect(app.model.doc.title).toBe('経費');
  });

  it('part fields (label, note): the field is not rebuilt on each keystroke', () => {
    app.editor.select([partId]);
    const fields = textInputs(app.root);
    expect(fields.length).toBeGreaterThanOrEqual(2);
    const label = fields[0];
    label.focus();
    for (const v of ['a', 'ab', 'abc']) {
      typeInto(label, v);
      expect(label.isConnected, v).toBe(true);
      expect(document.activeElement, v).toBe(label);
    }
    const note = textInputs(app.root)
      .filter((e) => e.tagName === 'TEXTAREA')
      .pop()!;
    note.focus();
    for (const v of ['押', '押すと保存']) {
      typeInto(note, v);
      expect(document.activeElement, v).toBe(note);
    }
    const part = app.model.doc.screens[0].parts.find((p: any) => p.id === partId);
    expect(part.label).toBe('abc');
    expect(part.note).toBe('押すと保存');
  });

  it('rebuilds the panel when the selection changes', () => {
    app.editor.select([partId]);
    const before = textInputs(app.root)[0];
    app.editor.select([]);
    expect(before.isConnected).toBe(false);
    expect(textInputs(app.root)[0].value).toBe(app.model.doc.title || '');
  });

  it('rebuilds even while typing when the selected part is removed', () => {
    app.editor.select([partId]);
    const label = textInputs(app.root)[0];
    label.focus();
    app.model.remove([partId]);
    expect(label.isConnected).toBe(false);
    expect(app.editor.selection()).toEqual([]);
  });

  it('rebuilds even while typing when the document is replaced (opened, changed from outside)', () => {
    app.editor.select([]);
    const input = textInputs(app.root)[0];
    input.focus();
    typeInto(input, 'old title');
    const next = w.DesignDoc.emptyDoc();
    next.title = 'title written outside';
    app.model.replace(next);
    expect(input.isConnected).toBe(false);
    expect(textInputs(app.root)[0].value).toBe('title written outside');
  });

  it('number fields are rebuilt once the value is committed (shows the snapped value)', () => {
    app.editor.select([partId]);
    const x = app.root.querySelector('input[type=number]') as HTMLInputElement;
    x.focus();
    x.value = '13';
    x.dispatchEvent(new Event('change', { bubbles: true }));
    const part = app.model.doc.screens[0].parts.find((p: any) => p.id === partId);
    expect(part.x % 4).toBe(0);
    expect(x.isConnected).toBe(false);
    expect((app.root.querySelector('input[type=number]') as HTMLInputElement).value).toBe(String(part.x));
  });
});
