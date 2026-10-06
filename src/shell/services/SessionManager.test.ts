import { describe, it, expect, vi } from 'vitest';
import type { Turn } from '../../core/state/HistoryManager';
import type { SessionMeta, CurrentSessionMeta } from '../../core/state/sessionArchive';
import { SessionManager } from './SessionManager';

/** 実物の HistoryManager は IndexedDB を開くので、同じ口を持つ偽物を使う（IDB の読み書きは実機で確かめる） */
class FakeHistory {
  turns: Turn[] = [];
  store = new Map<string, unknown>();
  listeners: Array<(p: any) => void> = [];
  persisted = 0;
  private seq = 0;
  on(_e: 'change', cb: (p: any) => void) {
    this.listeners.push(cb);
    return () => {};
  }
  private notify(p: any) {
    this.listeners.forEach((cb) => cb(p));
  }
  get() {
    return this.turns;
  }
  load(turns: Turn[]) {
    this.turns = turns;
    this.notify({ type: 'load', count: turns.length, turn: null });
  }
  append(role: Turn['role'], content: Turn['content'], meta: Turn['meta'] = {}) {
    const turn: Turn = {
      id: `t${++this.seq}`,
      timestamp: 1000 + this.seq,
      role,
      content,
      meta: { trigger_llm: true, ...meta },
    };
    this.turns.push(turn);
    this.notify({ type: 'append', count: this.turns.length, turn });
    return turn;
  }
  clear() {
    this.turns = [];
    this.notify({ type: 'clear', count: 0, previousCount: 0, turn: null });
  }
  async persist() {
    this.persisted++;
  }
  async getCurrentMeta() {
    return this.store.get('current_meta') as CurrentSessionMeta | undefined;
  }
  async setCurrentMeta(m: CurrentSessionMeta) {
    this.store.set('current_meta', m);
  }
  async getSessionsIndex() {
    return (this.store.get('sessions_index') as SessionMeta[]) ?? [];
  }
  async setSessionsIndex(i: SessionMeta[]) {
    this.store.set('sessions_index', i);
  }
  async getSession(id: string) {
    return this.store.get(`session:${id}`) as Turn[] | undefined;
  }
  async putSession(id: string, turns: Turn[]) {
    this.store.set(`session:${id}`, turns);
  }
  async deleteSession(id: string) {
    this.store.delete(`session:${id}`);
  }
}

class FakeVfs {
  /** 中身は文字列で持つ（Blob は text に戻して入れる） */
  files = new Map<string, string>();
  dirs = new Set<string>();
  deleted: string[] = [];
  private isDirPath(path: string) {
    if (this.dirs.has(path)) return true;
    for (const k of this.files.keys()) if (k.startsWith(path + '/')) return true;
    return false;
  }
  exists(_p: any, path: string) {
    return this.files.has(path) || this.isDirPath(path);
  }
  stat(_p: any, path: string) {
    if (this.files.has(path))
      return { path, name: path.split('/').pop(), kind: 'file', size: this.files.get(path)!.length, updatedAt: 7 };
    if (this.isDirPath(path)) return { path, name: path.split('/').pop(), kind: 'directory', size: 0, updatedAt: 7 };
    throw new Error(`Path not found: ${path}`);
  }
  async mkdir(_p: any, path: string) {
    this.dirs.add(path);
    return path;
  }
  listFiles(_p: any, opts: any) {
    const root = opts.path + '/';
    const out = new Map<string, any>();
    const add = (path: string, kind: 'file' | 'directory') => {
      if (!out.has(path))
        out.set(path, {
          path,
          name: path.split('/').pop(),
          kind,
          size: kind === 'file' ? this.files.get(path)!.length : 0,
          updatedAt: 7,
        });
    };
    const consider = (path: string, kind: 'file' | 'directory') => {
      if (!path.startsWith(root)) return;
      const rel = path.slice(root.length);
      const parts = rel.split('/');
      if (opts.recursive) {
        for (let i = 1; i < parts.length; i++) add(root + parts.slice(0, i).join('/'), 'directory');
        add(path, kind);
      } else {
        if (parts.length === 1) add(path, kind);
        else add(root + parts[0], 'directory');
      }
    };
    for (const k of this.files.keys()) consider(k, 'file');
    for (const d of this.dirs) consider(d, 'directory');
    return [...out.values()];
  }
  async deleteFile(_p: any, path: string) {
    for (const k of [...this.files.keys()]) if (k === path || k.startsWith(path + '/')) this.files.delete(k);
    for (const d of [...this.dirs]) if (d === path || d.startsWith(path + '/')) this.dirs.delete(d);
    this.deleted.push(path);
    return path;
  }
  async writeFile(_p: any, path: string, content: string | Blob) {
    this.files.set(path, typeof content === 'string' ? content : await content.text());
    return path;
  }
  async readFile(_p: any, path: string) {
    const v = this.files.get(path);
    if (v === undefined) throw new Error(`Path not found: ${path}`);
    return v;
  }
  async readBlob(_p: any, path: string) {
    return new Blob([await this.readFile(_p, path)]);
  }
}

const logger = { log: vi.fn() } as any;
const toolRegistry = { getActiveDynamicToolDefinitions: () => ['<define_tag name="x">x</define_tag>'] } as any;
const principal = { type: 'user', id: 'u' } as any;

function setup(keep = 10, sessionsDir: string | null = 'data/sessions') {
  const history = new FakeHistory();
  const vfs = new FakeVfs();
  let now = 5000;
  const sm = new SessionManager(vfs as any, history as any, logger, toolRegistry, {
    keep: () => keep,
    sessionsDir: () => sessionsDir,
    now: () => now++,
  });
  const changed = vi.fn();
  sm.setOnSessionChangedCallback(changed);
  return { history, vfs, sm, changed };
}

const media = (path: string) => ({ media: { path, mimeType: 'image/png' } });

describe('SessionManager: 空にすると退避される', () => {
  it('clear で前の会話が退避され、索引に札が入り、tool_available と引き継ぎが積まれる', async () => {
    const { history, sm, changed } = setup();
    history.append('user', 'first question');
    history.append('model', '<report>a</report>');
    await sm.clearSession({ summary: 'carry', triggerLlm: true, restoreTools: true });

    const index = await history.getSessionsIndex();
    expect(index).toHaveLength(1);
    expect(index[0].title).toBe(''); // 最初の発言は題にしない
    expect(index[0].turnCount).toBe(2);
    expect(await history.getSession(index[0].id)).toHaveLength(2);
    expect(history.turns.map((t) => t.meta.type)).toEqual(['tool_available', 'event_log']);
    expect(history.turns[1].meta.trigger_llm).toBe(true);
    expect(changed).toHaveBeenCalledTimes(1);
    // いまの会話の札は新しくなる
    const cur = await history.getCurrentMeta();
    expect(cur?.id).not.toBe(index[0].id);
  });

  it('発言の無い会話は退避しない', async () => {
    const { history, sm } = setup();
    history.append('system', '<event type="tool_available">x</event>', { type: 'tool_available', trigger_llm: false });
    await sm.clearSession({});
    expect(await history.getSessionsIndex()).toEqual([]);
  });

  it('keep を超えた分は古い方から消え、その本体も消える', async () => {
    const { history, sm } = setup(2);
    for (let i = 0; i < 4; i++) {
      history.append('user', `q${i}`);
      await sm.renameSession('current', `q${i}`);
      await sm.clearSession({});
    }
    const index = await history.getSessionsIndex();
    expect(index.map((m) => m.title).sort()).toEqual(['q2', 'q3']);
    const bodies = [...history.store.keys()].filter((k) => k.startsWith('session:'));
    expect(bodies).toHaveLength(2);
  });
});

describe('SessionManager: 添付の掃除', () => {
  it('退避中の会話が参照する添付は残り、誰も参照しないものだけ消える', async () => {
    const { history, vfs, sm } = setup();
    vfs.files.set('system/temp/media/kept.png', '');
    vfs.files.set('system/temp/media/orphan.png', '');
    history.append('user', [media('system/temp/media/kept.png'), { text: 'see' }]);
    await sm.clearSession({});
    expect(vfs.deleted).toEqual(['system/temp/media/orphan.png']);
    expect(vfs.files.has('system/temp/media/kept.png')).toBe(true);
  });

  it('会話を削除すると、その会話だけが参照していた添付も消える', async () => {
    const { history, vfs, sm } = setup();
    vfs.files.set('system/temp/media/only.png', '');
    history.append('user', [media('system/temp/media/only.png')]);
    await sm.clearSession({});
    expect(vfs.files.has('system/temp/media/only.png')).toBe(true);
    const [meta] = await history.getSessionsIndex();
    await sm.deleteSession(meta.id);
    expect(vfs.files.has('system/temp/media/only.png')).toBe(false);
    expect(await history.getSessionsIndex()).toEqual([]);
  });
});

describe('SessionManager: 切り替え', () => {
  it('切り替えると前の会話が退避され、戻した会話の後ろに復帰の印（trigger_llm: false）が積まれる', async () => {
    const { history, sm, changed } = setup();
    history.append('user', 'old');
    history.append('model', '<report>old answer</report>');
    await sm.clearSession({});
    const [old] = await history.getSessionsIndex();
    history.append('user', 'new');
    await sm.renameSession('current', 'new');

    const res = await sm.switchSession(old.id);
    expect(res).toEqual({ ok: true, id: old.id });
    expect(history.turns.map((t) => t.role)).toEqual(['user', 'model', 'system']);
    expect(history.turns[0].content).toBe('old');
    const marker = history.turns[2];
    expect(marker.meta.trigger_llm).toBe(false);
    expect(marker.meta.eventType).toBe('session_switched');
    expect(String(marker.content)).toContain('<define_tag name="x">');
    expect(history.persisted).toBe(1);
    expect(changed).toHaveBeenCalledTimes(2);
    // 戻した会話は索引から外れ、「new」の会話が代わりに退避されている
    const index = await history.getSessionsIndex();
    expect(index.map((m) => m.title)).toEqual(['new']);
    expect(await history.getSession(old.id)).toBeUndefined();
    expect((await history.getCurrentMeta())?.id).toBe(old.id);
  });

  it('題は付け替えられ、退避・切り替えについて回る。空にすると題なし', async () => {
    const { history, sm } = setup();
    history.append('user', 'a');
    expect(await sm.renameSession('current', '  見積の相談  ')).toBe(true);
    expect((await sm.currentSession()).title).toBe('見積の相談');
    await sm.clearSession({});
    const [old] = await history.getSessionsIndex();
    expect(old.title).toBe('見積の相談');
    expect(await sm.renameSession(old.id, '改題')).toBe(true);
    expect((await history.getSessionsIndex())[0].title).toBe('改題');
    expect(await sm.renameSession('nope', 'x')).toBe(false);
    await sm.switchSession(old.id);
    expect((await sm.currentSession()).title).toBe('改題');
    expect(await sm.renameSession('current', '')).toBe(true);
    expect((await sm.currentSession()).title).toBe('');
  });

  it('エンジンが走っている間は断る（何も変えない）', async () => {
    const { history, sm } = setup();
    history.append('user', 'old');
    await sm.clearSession({});
    const [old] = await history.getSessionsIndex();
    history.append('user', 'new');
    sm.setBusyProbe(() => true);
    expect(await sm.switchSession(old.id)).toEqual({ ok: false, reason: 'busy' });
    expect(history.turns.map((t) => t.content)).toEqual(['new']);
    expect(await history.getSessionsIndex()).toHaveLength(1);
  });

  it('無い id は missing', async () => {
    const { sm } = setup();
    expect(await sm.switchSession('nope')).toEqual({ ok: false, reason: 'missing' });
  });
});

describe('SessionManager: VFS への保存・VFS からの読み込み', () => {
  it('いまの会話を書き出し、読み戻すと同じターンで切り替わる（id が衝突すれば採り直す）', async () => {
    const { history, vfs, sm } = setup();
    history.append('user', 'saved one');
    history.append('model', '<report>x</report>');
    await sm.renameSession('current', 'saved one');
    expect(await sm.exportSessionToVfs('current', 'data/sessions/a.json', principal)).toBe(true);
    const json = JSON.parse(vfs.files.get('data/sessions/a.json')!);
    expect(json.format).toBe('itera-session/1');
    expect(json.title).toBe('saved one');
    expect(json.turns).toHaveLength(2);
    const currentId = (await history.getCurrentMeta())!.id;
    expect(json.id).toBe(currentId);

    const res = await sm.importSessionFromVfs('data/sessions/a.json', principal);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.id).not.toBe(currentId); // いまの会話と同じ id なので採り直し
    expect(history.turns.slice(0, 2).map((t) => t.content)).toEqual(['saved one', '<report>x</report>']);
    expect(history.turns[2].meta.eventType).toBe('session_loaded');
    expect((await sm.currentSession()).title).toBe('saved one'); // 題もファイルから戻る
    // 書き出す前の会話は退避されている
    expect((await history.getSessionsIndex()).map((m) => m.title)).toEqual(['saved one']);
  });

  it('形が違うファイルは断り、会話は変わらない', async () => {
    const { history, vfs, sm } = setup();
    vfs.files.set('data/x.json', '{"format":"other","turns":[]}');
    history.append('user', 'keep me');
    const res = await sm.importSessionFromVfs('data/x.json', principal);
    expect(res.ok).toBe(false);
    expect(history.turns.map((t) => t.content)).toEqual(['keep me']);
    expect(await sm.importSessionFromVfs('data/none.json', principal)).toMatchObject({ ok: false, reason: 'invalid' });
  });

  it('退避した会話も書き出せる', async () => {
    const { history, sm } = setup();
    history.append('user', 'archived');
    await sm.clearSession({});
    const [m] = await history.getSessionsIndex();
    const json = JSON.parse((await sm.exportSession(m.id))!);
    expect(json.id).toBe(m.id);
    expect(json.turns[0].content).toBe('archived');
    expect(await sm.exportSession('nope')).toBeNull();
  });
});

describe('SessionManager: 既定の保存先（paths.user.sessions）', () => {
  it('ダイアログ無しで保存先へ書き、名前は会話の始まりの日時＋題。保存し直すと同じファイルを上書き', async () => {
    const { history, vfs, sm } = setup();
    history.append('user', 'hello world');
    await sm.renameSession('current', 'hello world');
    const p1 = await sm.exportSessionToDefaultDir('current', principal);
    expect(p1).toMatch(/^data\/sessions\/\d{8}_\d{4}_hello_world$/);
    expect(vfs.files.has(`${p1}/session.json`)).toBe(true);
    history.append('model', '<report>x</report>');
    const p2 = await sm.exportSessionToDefaultDir('current', principal);
    expect(p2).toBe(p1);
    expect(JSON.parse(vfs.files.get(`${p1}/session.json`)!).turns).toHaveLength(2);
    expect([...vfs.files.keys()].filter((k) => k.startsWith('data/sessions/'))).toHaveLength(1);
  });

  it('保存先の一覧は名前と stat だけで組む（readFile を呼ばない）', async () => {
    const { history, vfs, sm } = setup();
    history.append('user', 'listed');
    await sm.renameSession('current', 'listed');
    await sm.exportSessionToDefaultDir('current', principal);
    vfs.files.set('data/sessions/other.txt', 'x');
    const read = vi.spyOn(vfs, 'readFile');
    const rows = sm.listSavedSessions(principal);
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe('listed');
    expect(rows[0].form).toBe('dir');
    expect(read).not.toHaveBeenCalled();
  });

  it('添付はいまの会話のディレクトリ（system/temp/sessions/<id>）に置き、保存はそれを media/ に同梱し、読み込みで写して参照を付け替える', async () => {
    const { history, vfs, sm } = setup();
    await sm.init();
    const dir = sm.currentMediaDir();
    expect(dir).toMatch(/^system\/temp\/sessions\/[^/]+$/);
    vfs.files.set(`${dir}/1_photo.png`, 'PNG');
    vfs.files.set(`${dir}/2_memo.txt`, 'memo');
    vfs.files.set('system/temp/media/legacy.png', 'OLD');
    history.append('user', [
      media(`${dir}/1_photo.png`),
      { text: `<user_attachment name="memo.txt" path="${dir}/2_memo.txt">memo</user_attachment>` },
      media('system/temp/media/legacy.png'),
      media('data/docs/big.pdf'),
    ]);
    await sm.renameSession('current', 'bundle');
    const saved = await sm.exportSessionToDefaultDir('current', principal);
    expect(saved).toMatch(/_bundle$/);
    expect([...vfs.files.keys()].filter((k) => k.startsWith(`${saved}/media/`)).sort()).toEqual([
      `${saved}/media/1_photo.png`,
      `${saved}/media/2_memo.txt`,
      `${saved}/media/legacy.png`,
    ]);
    expect(vfs.files.has(`${saved}/media/big.pdf`)).toBe(false); // VFS の別の場所への参照は同梱しない

    // 読み込み（同じ id が居るので採り直し → 新しいディレクトリへ写り、参照が付け替わる）
    const res = await sm.importSessionFromVfs(saved!, principal);
    expect(res.ok).toBe(true);
    const newDir = sm.currentMediaDir();
    expect(newDir).not.toBe(dir);
    expect(vfs.files.get(`${newDir}/1_photo.png`)).toBe('PNG');
    expect(vfs.files.get(`${newDir}/legacy.png`)).toBe('OLD');
    const content = history.turns[0].content as any[];
    expect(content[0].media.path).toBe(`${newDir}/1_photo.png`);
    expect(content[1].text).toContain(`path="${newDir}/2_memo.txt"`);
    expect(content[2].media.path).toBe(`${newDir}/legacy.png`);
    expect(content[3].media.path).toBe('data/docs/big.pdf');
    // 古い会話は退避され、そのディレクトリは残る（退避中）。削除すると消える
    const [old] = await history.getSessionsIndex();
    expect(vfs.exists(null, dir)).toBe(true);
    await sm.deleteSession(old.id);
    expect(vfs.exists(null, dir)).toBe(false);
    expect(vfs.exists(null, newDir)).toBe(true);
  });

  it('旧形式の単一 .json も読み込める（添付は無い）', async () => {
    const { history, sm } = setup();
    history.append('user', 'legacy');
    await sm.exportSessionToVfs('current', 'data/sessions/20261001_0900_legacy.json', principal);
    const rows = sm.listSavedSessions(principal);
    expect(rows.map((r) => r.form)).toEqual(['file']);
    const res = await sm.importSessionFromVfs('data/sessions/20261001_0900_legacy.json', principal);
    expect(res.ok).toBe(true);
    expect(history.turns[0].content).toBe('legacy');
  });

  it('保存先の宣言が無ければ null と空', async () => {
    const { history, sm } = setup(10, null);
    history.append('user', 'x');
    expect(sm.savedSessionsDir()).toBeNull();
    expect(await sm.exportSessionToDefaultDir('current', principal)).toBeNull();
    expect(sm.listSavedSessions(principal)).toEqual([]);
  });
});
