// @vitest-environment jsdom
/**
 * tests/guest/designCanvasI18n.test.ts
 * Design Canvas の言葉（T-0812）。画面の文字・置いたときの部品の文字・AI に送る要約は `js/i18n.js` の表から引く。
 * 既定は英語、OS の appearance.locale が ja のとき日本語。
 *
 * 見ること:
 *  - 表: 英語と日本語で鍵がそろっている・文の中の穴（{name}）も同じ
 *  - 直書きが無い: 表のほかのファイル（js・html）のコードに日本語の文字が無い
 *  - 鍵が在る: ソースが引く鍵（say('…')・data-i18n）が表に在る。組み立てる鍵（kind.<部品>.name など）は
 *    28 種の部品を実際に置いてパネルを描き、鍵のままの文字が画面に出ないことで見る
 *  - 言語の切り替え: 部品の名前・置いたときの文字・新しい画面の名前・要約・HTML の文字
 *  - 登録: 登録簿・関連付け・手引き・script の実在
 *
 * 実装をコピーせず、ソースをそのまま jsdom で動かす。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(__dirname, '../../vfs_root');
const APP = resolve(ROOT, 'system/apps/design_canvas');
const read = (p: string) => readFileSync(p, 'utf8');
const JS = ['i18n.js', 'parts.js', 'model.js', 'editor.js', 'panel.js', 'preview.js', 'snapshot.js', 'main.js'];
const src = Object.fromEntries(JS.map((f) => [f, read(resolve(APP, 'js', f))]));
const html = read(resolve(APP, 'design_canvas.html'));
// 配布物ごとに違うのはこの 2 つだけ（手引きの置き場・保存先の既定）
const MANUAL_DIR = 'docs/manual';
const SAVE_DIR = 'data/designs';

/* eslint-disable @typescript-eslint/no-explicit-any */
const w = window as any;

// ひらがな・カタカナ・漢字・全角の記号
const JA = /[\u3040-\u30ff\u4e00-\u9fff\uff00-\uffef]/;
const stripJsComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/[^\n]*/g, '$1');
const stripHtmlComments = (s: string) => s.replace(/<!--[\s\S]*?-->/g, '');
const holes = (s: string) => (s.match(/\{\w+\}/g) || []).sort().join(' ');
// 表に無い鍵は鍵のまま返る（i18n.js の t）。画面に出ていたら、引いた鍵が表に無い
const RAW_KEY =
  /\b(app|file|list|status|dialog|banner|send|doc|err|warn|sum|note|preview|kind|variant|textLabel|color|transition|panel|act|arrange|screen|field|part|nav)\.[A-Za-z]+(\.[A-Za-z]+)*\b/;

/** 言葉の表・部品・文書・キャンバス・パネルを読み込んで、空の設計で起こす */
function boot(locale?: string) {
  document.body.innerHTML = '<main id="viewport"></main><aside id="panel"></aside>';
  for (const f of ['i18n.js', 'parts.js', 'model.js', 'editor.js', 'panel.js']) new Function(src[f])();
  if (locale) w.DesignI18n.setLocale(locale);
  const model = new w.DesignModel(w.DesignDoc.emptyDoc());
  const editor = new w.DesignEditor(model, document.getElementById('viewport'));
  const root = document.getElementById('panel') as HTMLElement;
  const panel = new w.DesignPanel(model, editor, root);
  return { model, editor, panel, root };
}
const table = () => {
  new Function(src['i18n.js'])();
  return w.DesignI18n.T as Record<string, Record<string, string>>;
};

describe('Design Canvas: the string table', () => {
  it('has the same keys and the same placeholders in English and Japanese', () => {
    const T = table();
    expect(Object.keys(T).sort()).toEqual(['en-US', 'ja-JP']);
    expect(Object.keys(T['ja-JP']).sort()).toEqual(Object.keys(T['en-US']).sort());
    for (const k of Object.keys(T['en-US'])) expect(holes(T['ja-JP'][k]), k).toBe(holes(T['en-US'][k]));
  });

  it('keeps Japanese out of the English table', () => {
    const T = table();
    const bad = Object.entries(T['en-US']).filter(([, v]) => JA.test(v));
    expect(bad).toEqual([]);
  });

  it('is the only place with user-facing text (no Japanese in the code of other files)', () => {
    for (const f of JS.filter((x) => x !== 'i18n.js')) {
      const lines = stripJsComments(src[f])
        .split('\n')
        .filter((l) => JA.test(l));
      expect(lines, f).toEqual([]);
    }
    const lines = stripHtmlComments(html)
      .split('\n')
      .filter((l) => JA.test(l));
    expect(lines, 'design_canvas.html').toEqual([]);
  });

  it('contains every key the sources ask for by name', () => {
    const T = table();
    const used = new Set<string>();
    for (const f of JS) for (const m of src[f].matchAll(/\bsay\('([^']+)'/g)) used.add(m[1]);
    for (const m of html.matchAll(/data-i18n(?:-title)?="([^"]+)"/g)) used.add(m[1]);
    expect(used.size).toBeGreaterThan(120);
    const missing = [...used].filter((k) => T['en-US'][k] === undefined);
    expect(missing).toEqual([]);
  });

  it('the text written in the HTML is the English entry of its key', () => {
    const T = table();
    document.body.innerHTML = stripHtmlComments(html)
      .replace(/<script[\s\S]*?<\/script>/g, '')
      .replace(/^[\s\S]*<body[^>]*>/, '')
      .replace(/<\/body>[\s\S]*$/, '');
    const texts = [...document.querySelectorAll<HTMLElement>('[data-i18n]')];
    const titles = [...document.querySelectorAll<HTMLElement>('[data-i18n-title]')];
    expect(texts.length).toBeGreaterThanOrEqual(12);
    expect(titles.length).toBeGreaterThanOrEqual(10);
    for (const e of texts) expect(e.textContent!.trim(), e.dataset.i18n).toBe(T['en-US'][e.dataset.i18n!]);
    for (const e of titles) expect(e.title, e.dataset.i18nTitle).toBe(T['en-US'][e.dataset.i18nTitle!]);
    // 日本語に切り替えると差し替わる
    w.DesignI18n.setLocale('ja');
    w.DesignI18n.applyStatic();
    expect(document.documentElement.lang).toBe('ja');
    expect(document.title).toBe('デザインキャンバス');
    expect(document.getElementById('btn-save')!.textContent).toBe('保存');
    expect(document.getElementById('btn-save')!.title).toBe('保存（Ctrl+S）');
    w.DesignI18n.setLocale('en');
    w.DesignI18n.applyStatic();
    expect(document.documentElement.lang).toBe('en');
    expect(document.getElementById('btn-save')!.textContent).toBe('Save');
  });
});

describe('Design Canvas: language', () => {
  it('is English by default and Japanese only for ja locales', () => {
    table();
    const I = w.DesignI18n;
    expect(I.locale).toBe('en-US');
    expect(I.setLocale('ja')).toBe(true);
    expect(I.locale).toBe('ja-JP');
    expect(I.setLocale('ja-JP')).toBe(false);
    for (const l of ['en', 'fr', '', undefined, null, 'jam']) {
      I.setLocale(l);
      expect(I.locale, String(l)).toBe('en-US');
    }
    expect(I.t('no.such.key')).toBe('no.such.key');
    expect(I.t('status.saved', { path: 'a/b.design' })).toBe('Saved to a/b.design');
  });

  it('names parts, fills new parts and names new screens in the current language', () => {
    boot();
    expect(w.DesignParts.SPEC.header.name).toBe('Header');
    expect(w.DesignParts.create('button').label).toBe('Button');
    expect(w.DesignParts.create('list').text).toBe('First item\nSecond item\nThird item');
    expect(w.DesignDoc.emptyDoc().screens[0].name).toBe('Screen 1');
    w.DesignI18n.setLocale('ja');
    expect(w.DesignParts.SPEC.header.name).toBe('ヘッダー');
    expect(w.DesignParts.create('button').label).toBe('ボタン');
    expect(w.DesignParts.create('list').text).toBe('項目 1\n項目 2\n項目 3');
    expect(w.DesignDoc.emptyDoc().screens[0].name).toBe('画面 1');
  });

  it('keeps the field order of a new part and its language-independent defaults', () => {
    boot();
    expect(Object.keys(w.DesignParts.create('modal'))).toEqual(['kind', 'w', 'h', 'label', 'text', 'variant']);
    expect(w.DesignParts.create('iconButton').label).toBe('⚙');
    expect(w.DesignParts.create('stat')).toMatchObject({ label: 'This month', text: '128' });
    expect(w.DesignParts.create('box')).toEqual({ kind: 'box', w: 400, h: 240, fill: 'panel' });
    expect(w.DesignParts.KINDS.length).toBe(28);
  });

  it('writes the summary for the AI in the current language', () => {
    const doc = {
      format: 'itera-design/1',
      title: 'Expenses',
      brief: 'Monthly totals',
      screens: [
        {
          id: 's_1',
          name: 'List',
          x: 0,
          y: 0,
          w: 1280,
          h: 800,
          note: 'First screen',
          parts: [
            { id: 'p_1', kind: 'button', x: 0, y: 0, w: 120, h: 36, label: 'Add', note: 'n', to: { screen: 's_2' } },
            { id: 'p_2', kind: 'button', x: 0, y: 40, w: 120, h: 36, label: 'Close', to: { screen: 'back' } },
          ],
        },
        { id: 's_2', name: 'Edit', x: 1440, y: 0, w: 1280, h: 800, note: '', parts: [] },
      ],
      notes: [{ id: 'n_1', x: 0, y: -240, w: 240, h: 160, text: 'memo' }],
    };
    boot();
    expect(w.DesignDoc.summarize(doc, 'user/docs/designs/x.design', ' Build it ')).toBe(
      [
        '[Design Canvas] Sending a design: user/docs/designs/x.design',
        'Title: Expenses — Monthly totals',
        'Screens (2):',
        '- List (s_1): 2 parts (1 with notes) / First screen / Navigation: "Add" → Edit (s_2), "Close" → back',
        '- Edit (s_2): 0 parts',
        'Sticky notes: 1',
        '',
        'Build it',
      ].join('\n'),
    );
    w.DesignI18n.setLocale('ja');
    expect(w.DesignDoc.summarize(doc, 'user/docs/designs/x.design', '')).toBe(
      [
        '[デザインキャンバス] 設計を送信します: user/docs/designs/x.design',
        'アプリ名: Expenses — Monthly totals',
        '画面 2 枚:',
        '- List（s_1）: 部品 2（メモ付き 1） ／ First screen ／ 遷移: 「Add」→ Edit（s_2）、「Close」→ 戻る',
        '- Edit（s_2）: 部品 0',
        '付箋 1 枚',
      ].join('\n'),
    );
  });

  it.each(['en', 'ja'])('shows no raw key anywhere in the panel or on the canvas (%s, all 28 parts)', (locale) => {
    const app = boot(locale);
    const sid = app.model.doc.screens[0].id;
    const other = app.model.addScreen({ phone: true });
    const seen: string[] = [];
    const look = (what: string) => {
      const texts = [
        app.root.textContent || '',
        (document.getElementById('viewport') as HTMLElement).textContent || '',
        ...[...app.root.querySelectorAll('option')].map((o) => o.textContent || ''),
      ];
      for (const t of texts) {
        const m = t.match(RAW_KEY);
        if (m) seen.push(`${what}: ${m[0]}`);
      }
      if (locale === 'en' && texts.some((t) => JA.test(t))) seen.push(`${what}: Japanese text in English`);
    };
    look('design');
    const ids: string[] = [];
    for (const kind of w.DesignParts.KINDS) {
      const id = app.model.addPart(sid, kind, { x: 40, y: 40 });
      ids.push(id);
      app.model.patch(id, { to: { screen: other, transition: 'slide' } });
      app.editor.select([id]);
      look(kind);
    }
    app.model.patch(ids[0], { to: { screen: 's_gone', transition: 'fade' } }); // 無い画面への移動
    app.editor.select([ids[0]]);
    look('missing target');
    app.model.patch(ids[1], { kind: 'somethingNew' }); // 知らない部品
    app.editor.select([ids[1]]);
    look('unknown kind');
    app.editor.select(ids.slice(2, 4));
    look('two parts');
    app.editor.select(ids.slice(2, 6));
    look('four parts');
    app.editor.select([sid]);
    look('screen');
    app.editor.select([other]);
    look('screen with incoming navigation');
    app.editor.select([app.model.addNote()]);
    look('sticky note');
    expect(seen).toEqual([]);
  });
});

describe('Design Canvas: registration', () => {
  const apps = JSON.parse(read(resolve(ROOT, 'system/registry/apps.json'))) as any[];
  const assoc = JSON.parse(read(resolve(ROOT, 'system/registry/associations.json')));

  it('is a system app that appears on Home and opens .design files', () => {
    const app = apps.find((a) => a.id === 'design_canvas');
    expect(app).toBeTruthy();
    expect(app.path).toBe('system/apps/design_canvas/design_canvas.html');
    expect(existsSync(resolve(ROOT, app.path))).toBe(true);
    expect(app.home).not.toBe(false); // home:false だけがホームから外れる
    expect(app.fileHandlers.some((h: any) => h.extensions.includes('design'))).toBe(true);
    expect(assoc.extensions.design).toBe('design_canvas');
    expect(JA.test(app.name + app.description)).toBe(false);
  });

  it('loads scripts that exist, the string table first', () => {
    const scripts = [...html.matchAll(/<script[^>]*\ssrc="([^"]+)"/g)].map((m) => m[1]);
    const own = scripts.filter((s) => s.startsWith('/system/apps/design_canvas/'));
    expect(own.map((s) => s.split('/').pop())).toEqual(JS);
    for (const s of scripts) expect(existsSync(resolve(ROOT, s.slice(1))), s).toBe(true);
  });

  it('ships its manuals, and they point at paths that exist', () => {
    for (const f of ['design_canvas.md', 'design_canvas_format.md']) {
      const text = read(resolve(ROOT, MANUAL_DIR, f));
      expect(JA.test(text), f).toBe(false);
      for (const m of text.matchAll(/`((?:system|docs)\/[A-Za-z0-9_./-]+\.(?:md|js|html))`/g)) {
        expect(existsSync(resolve(ROOT, m[1])), `${f}: ${m[1]}`).toBe(true);
      }
    }
    expect(src['main.js']).toContain(`'${SAVE_DIR}'`);
    expect(existsSync(resolve(ROOT, SAVE_DIR.split('/').slice(0, -1).join('/')))).toBe(true);
  });
});
