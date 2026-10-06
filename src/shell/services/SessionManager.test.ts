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
  files = new Map<string, string>();
  deleted: string[] = [];
  exists(_p: any, path: string) {
    return path === 'system/temp/media' || this.files.has(path);
  }
  listFiles(_p: any, opts: any) {
    return [...this.files.keys()].filter((k) => k.startsWith(opts.path + '/')).map((path) => ({ path, kind: 'file' }));
  }
  async deleteFile(_p: any, path: string) {
    this.files.delete(path);
    this.deleted.push(path);
    return path;
  }
  async writeFile(_p: any, path: string, content: string) {
    this.files.set(path, content);
    return path;
  }
  async readFile(_p: any, path: string) {
    const v = this.files.get(path);
    if (v === undefined) throw new Error(`Path not found: ${path}`);
    return v;
  }
}

const logger = { log: vi.fn() } as any;
const toolRegistry = { getActiveDynamicToolDefinitions: () => ['<define_tag name="x">x</define_tag>'] } as any;
const principal = { type: 'user', id: 'u' } as any;

function setup(keep = 10) {
  const history = new FakeHistory();
  const vfs = new FakeVfs();
  let now = 5000;
  const sm = new SessionManager(vfs as any, history as any, logger, toolRegistry, {
    keep: () => keep,
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
    expect(index[0].title).toBe('first question');
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
    expect(await sm.exportSessionToVfs('current', 'data/sessions/a.json', principal)).toBe(true);
    const json = JSON.parse(vfs.files.get('data/sessions/a.json')!);
    expect(json.format).toBe('itera-session/1');
    expect(json.turns).toHaveLength(2);
    const currentId = (await history.getCurrentMeta())!.id;
    expect(json.id).toBe(currentId);

    const res = await sm.importSessionFromVfs('data/sessions/a.json', principal);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.id).not.toBe(currentId); // いまの会話と同じ id なので採り直し
    expect(history.turns.slice(0, 2).map((t) => t.content)).toEqual(['saved one', '<report>x</report>']);
    expect(history.turns[2].meta.eventType).toBe('session_loaded');
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
