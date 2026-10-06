import { describe, it, expect } from 'vitest';
import type { Turn } from './HistoryManager';
import {
  buildSessionExport,
  buildSessionMeta,
  collectMediaPaths,
  exportFileName,
  exportDirName,
  parseExportFileName,
  listSavedSessions,
  collectTempAttachmentPaths,
  relocateTempAttachments,
  sessionMediaDir,
  normalizeTitle,
  isEmptySession,
  normalizeKeep,
  parseSessionImport,
  pruneSessions,
  referencedMediaPaths,
  sortSessions,
  unreferencedMedia,
  SESSION_EXPORT_FORMAT,
  type SessionMeta,
} from './sessionArchive';

const turn = (role: Turn['role'], content: Turn['content'], timestamp = 1000, meta: Turn['meta'] = {}): Turn => ({
  id: `t${timestamp}`,
  timestamp,
  role,
  content,
  meta,
});

const meta = (id: string, updatedAt: number, mediaPaths: string[] = []): SessionMeta => ({
  id,
  title: id,
  createdAt: updatedAt - 10,
  updatedAt,
  turnCount: 1,
  bytes: 10,
  mediaPaths,
});

describe('sessionArchive: 空の会話', () => {
  it('ターンが無ければ空', () => {
    expect(isEmptySession([])).toBe(true);
  });
  it('system のターンしか無ければ空（リセット直後の tool_available だけの会話）', () => {
    expect(isEmptySession([turn('system', '<event type="tool_available">…</event>')])).toBe(true);
  });
  it('利用者か私の発言があれば空でない', () => {
    expect(isEmptySession([turn('user', 'hi')])).toBe(false);
    expect(isEmptySession([turn('system', 'x'), turn('model', '<report>…</report>')])).toBe(false);
  });
});

describe('sessionArchive: 題', () => {
  it('題は利用者が付けたものだけ。最初の発言から導かない（既定は空＝表示側が始まりの時刻で代える）', () => {
    expect(buildSessionMeta('s', 5, [turn('user', 'こんにちは')]).title).toBe('');
    expect(buildSessionMeta('s', 5, [turn('user', 'x')], ' 見積の相談 ').title).toBe('見積の相談');
  });
  it('整え方: 前後の空白と改行を落とし、80 字で切る。文字列以外は空', () => {
    expect(normalizeTitle('  a \n b  ')).toBe('a b');
    expect(normalizeTitle('あ'.repeat(100))).toBe('あ'.repeat(80));
    expect(normalizeTitle(undefined)).toBe('');
  });
});

describe('sessionArchive: 添付の参照', () => {
  it('利用者の添付とツールの結果の media を集め、重複は 1 つ', () => {
    const turns: Turn[] = [
      turn('user', [{ media: { path: 'system/temp/media/a.png', mimeType: 'image/png' } }, { text: 'x' }]),
      turn('system', [
        {
          actionType: 'take_screenshot',
          output: { log: 'ok', media: { path: 'system/temp/media/s.png', mimeType: 'image/png' } },
        },
        { actionType: 'get_time', output: { log: 'now' } },
      ] as any),
      turn('user', [{ media: { path: 'system/temp/media/a.png', mimeType: 'image/png' } }]),
    ];
    expect(collectMediaPaths(turns).sort()).toEqual(['system/temp/media/a.png', 'system/temp/media/s.png']);
  });
  it('残る会話のどれにも参照されていないファイルだけが掃除の対象', () => {
    const files = ['system/temp/media/a.png', 'system/temp/media/b.png', 'system/temp/media/c.png'];
    const referenced = referencedMediaPaths(
      [meta('s1', 1, ['system/temp/media/a.png'])],
      [turn('user', [{ media: { path: 'system/temp/media/c.png', mimeType: 'image/png' } }])],
    );
    expect(unreferencedMedia(files, referenced)).toEqual(['system/temp/media/b.png']);
  });
});

describe('sessionArchive: 札と剪定', () => {
  it('updatedAt は最後のターンの時刻、無ければ createdAt', () => {
    expect(buildSessionMeta('s', 5, []).updatedAt).toBe(5);
    expect(buildSessionMeta('s', 5, [turn('user', 'a', 10), turn('model', 'b', 20)]).updatedAt).toBe(20);
  });
  it('新しい順に並び、keep を超えた分を古い方から剪定', () => {
    const index = [meta('a', 1), meta('b', 3), meta('c', 2), meta('d', 4)];
    expect(sortSessions(index).map((m) => m.id)).toEqual(['d', 'b', 'c', 'a']);
    const { kept, pruned } = pruneSessions(index, 2);
    expect(kept.map((m) => m.id)).toEqual(['d', 'b']);
    expect(pruned.map((m) => m.id)).toEqual(['c', 'a']);
  });
  it('keep=0 は全部剪定、既定の整え方', () => {
    expect(pruneSessions([meta('a', 1)], 0).kept).toEqual([]);
    expect(normalizeKeep(undefined)).toBe(10);
    expect(normalizeKeep(-1)).toBe(10);
    expect(normalizeKeep('3')).toBe(10);
    expect(normalizeKeep(3.7)).toBe(3);
  });
});

describe('sessionArchive: VFS との出し入れ', () => {
  const turns = [turn('user', 'hello', 10), turn('model', '<report>hi</report>', 20)];

  it('書き出しはターンをそのまま持ち、読み戻せる', () => {
    const exported = buildSessionExport({ id: 'sid', createdAt: 5, title: '題' }, turns, 99);
    expect(exported.format).toBe(SESSION_EXPORT_FORMAT);
    expect(exported.title).toBe('題');
    expect(exported.turns).toBe(turns);
    const parsed = parseSessionImport(JSON.stringify(exported));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.id).toBe('sid');
      expect(parsed.title).toBe('題');
      expect(parsed.createdAt).toBe(5);
      expect(parsed.turns).toEqual(turns);
    }
  });
  it('形が違えば理由を返して拒む', () => {
    expect(parseSessionImport('not json').ok).toBe(false);
    expect(parseSessionImport('[]').ok).toBe(false);
    expect(parseSessionImport(JSON.stringify({ format: 'x', turns: [] }))).toMatchObject({ ok: false });
    expect(parseSessionImport(JSON.stringify({ format: SESSION_EXPORT_FORMAT }))).toMatchObject({ ok: false });
    const bad = parseSessionImport(JSON.stringify({ format: SESSION_EXPORT_FORMAT, turns: [{ id: 1 }] }));
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.reason).toContain('turn #1');
  });
  it('meta の無いターンは {} で埋め、createdAt が無ければ最初のターンの時刻', () => {
    const parsed = parseSessionImport(
      JSON.stringify({ format: SESSION_EXPORT_FORMAT, turns: [{ id: 'a', timestamp: 7, role: 'user', content: 'x' }] }),
    );
    expect(parsed).toMatchObject({ ok: true, id: '', title: '', createdAt: 7 });
    if (parsed.ok) expect(parsed.turns[0].meta).toEqual({});
  });
  it('保存のファイル名は会話の始まりの日時と題から（名前に使えない字は外す）。同じ会話なら同じ名前', () => {
    const d = new Date(2026, 9, 6, 17, 5).getTime();
    expect(exportFileName({ title: 'a/b: c?', createdAt: d })).toBe('20261006_1705_a_b_c.json');
    expect(exportFileName({ title: '', createdAt: d })).toBe('20261006_1705.json');
    expect(exportFileName({ title: 'x', createdAt: d })).toBe(exportFileName({ title: 'x', createdAt: d }));
  });
  it('名前から日時と題を戻せる。形が違えば題は名前のまま', () => {
    const d = new Date(2026, 9, 6, 17, 5).getTime();
    expect(parseExportFileName('20261006_1705_a_b_c.json')).toEqual({ title: 'a b c', startedAt: d });
    expect(parseExportFileName('20261006_1705.json')).toEqual({ title: '', startedAt: d });
    expect(parseExportFileName('notes.json')).toEqual({ title: 'notes', startedAt: null });
  });
  it('保存先の一覧: session.json を持つディレクトリと、旧形式の単一 .json を新しい順に（中身は読まない）', () => {
    const rows = listSavedSessions('d', [
      { path: 'd/20261006_1705_old.json', name: '20261006_1705_old.json', kind: 'file', size: 10, updatedAt: 1 },
      { path: 'd/20261007_0900_new', name: '20261007_0900_new', kind: 'directory', size: 0, updatedAt: 2 },
      { path: 'd/20261007_0900_new/session.json', name: 'session.json', kind: 'file', size: 20, updatedAt: 2 },
      { path: 'd/20261007_0900_new/media', name: 'media', kind: 'directory', size: 0, updatedAt: 2 },
      {
        path: 'd/20261007_0900_new/media/a.png',
        name: 'a.png',
        kind: 'file',
        size: 300,
        updatedAt: 3,
        syncState: 'stub',
      },
      { path: 'd/nosession', name: 'nosession', kind: 'directory', size: 0, updatedAt: 4 },
      { path: 'd/nosession/x.png', name: 'x.png', kind: 'file', size: 1, updatedAt: 4 },
      { path: 'd/readme.md', name: 'readme.md', kind: 'file', size: 5, updatedAt: 3 },
    ]);
    expect(rows.map((r) => r.name)).toEqual(['20261007_0900_new', '20261006_1705_old.json']);
    expect(rows[0]).toMatchObject({ title: 'new', stub: true, size: 320, form: 'dir', path: 'd/20261007_0900_new' });
    expect(rows[1]).toMatchObject({ form: 'file', stub: false });
    expect(exportDirName({ title: 'x', createdAt: new Date(2026, 9, 6, 17, 5).getTime() })).toBe('20261006_1705_x');
  });
});

describe('sessionArchive: 添付の置き場と付け替え', () => {
  const dir = sessionMediaDir('abc');
  const turns: Turn[] = [
    turn('user', [
      { media: { path: `${dir}/1_a.png`, mimeType: 'image/png' } },
      {
        text: `<user_attachment name="m.txt" path="${dir}/2_m.txt">x</user_attachment> see <user_attachment path="data/doc.md">[Existing VFS Path]</user_attachment>`,
      },
    ]),
    turn('system', [
      {
        actionType: 'take_screenshot',
        output: { log: 'ok', media: { path: 'system/temp/media/shot.png', mimeType: 'image/png' } },
      },
    ] as any),
    turn('user', '<user_attachment path="system/temp/media/gone.png">[Binary]</user_attachment>'),
  ];
  it('置き場は system/temp/sessions/<id>', () => {
    expect(dir).toBe('system/temp/sessions/abc');
  });
  it('system/temp の下の参照だけを集める（本文の user_attachment も）', () => {
    expect(collectTempAttachmentPaths(turns).sort()).toEqual(
      [`${dir}/1_a.png`, `${dir}/2_m.txt`, 'system/temp/media/gone.png', 'system/temp/media/shot.png'].sort(),
    );
  });
  it('同梱されている名前だけを新しい置き場へ向け、別の場所への参照と無い名前は触らない。元は変えない', () => {
    const out = relocateTempAttachments(turns, 'system/temp/sessions/new', ['1_a.png', '2_m.txt', 'shot.png']);
    const c0 = out[0].content as any[];
    expect(c0[0].media.path).toBe('system/temp/sessions/new/1_a.png');
    expect(c0[1].text).toContain('path="system/temp/sessions/new/2_m.txt"');
    expect(c0[1].text).toContain('path="data/doc.md"');
    expect((out[1].content as any[])[0].output.media.path).toBe('system/temp/sessions/new/shot.png');
    expect(out[2].content).toContain('path="system/temp/media/gone.png"');
    expect((turns[0].content as any[])[0].media.path).toBe(`${dir}/1_a.png`);
  });
});
