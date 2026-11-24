/**
 * src/core/state/EngineConversation.test.ts
 * アプリが作ったエンジンの会話の口（T-0908）。
 */
import { describe, expect, it } from 'vitest';
import { EngineConversation, engineMediaDir } from './EngineConversation';
import { FakeVfs } from './bundleTestKit';
import { sessionResetEvent, toolsRestoredEvent } from './conversationEvents';
import type { SessionExport } from './sessionArchive';
import type { Principal } from '../vfs/types';

const APP: Principal = { type: 'app', id: 'viewer' };
const DEF = '<toolset name="Web" pid="web">\n  <define_tag name="search">S</define_tag>\n</toolset>';
const media = (path: string) => ({ media: { path, mimeType: 'image/png', metadata: {} } });

function make(engineId = 'eng-1', options: { vfs?: FakeVfs; defs?: string[] } = {}) {
  const vfs = options.vfs ?? new FakeVfs();
  const defs = options.defs ?? [];
  /** 持ち主へ渡された会話と、渡された瞬間に会話に在ったターンの数 */
  const handed: Array<{ session: SessionExport; turnsAtCall: number }> = [];
  let clock = 1000;
  const conv: EngineConversation = new EngineConversation({
    engineId,
    vfs,
    toolDefinitions: () => defs,
    onReset: (session) => handed.push({ session, turnsAtCall: conv.history.get().length }),
    now: () => clock++,
  });
  return { conv, vfs, defs, handed };
}

describe('EngineConversation — 始まり', () => {
  it('会話の id を自分で振る。添付の置き場はエンジンの id から決まる', async () => {
    const { conv } = make('eng-1');
    expect(conv.currentId()).toBeTruthy();
    expect(await conv.current()).toEqual({ id: conv.currentId(), title: '', createdAt: 1000 });
    expect(conv.mediaDir).toBe('system/temp/engines/eng-1');
    expect(engineMediaDir('eng-1')).toBe(conv.mediaDir);
    expect(conv.history.get()).toEqual([]);
  });

  it('見えている道具の定義を置く。起こさない', () => {
    const { conv } = make('eng-1', { defs: [DEF] });
    conv.announceStart();
    const turns = conv.history.get();
    expect(turns.map((t) => [t.role, t.content])).toEqual([['system', toolsRestoredEvent([DEF])!.content]]);
    expect(turns[0].meta).toMatchObject({ eventType: 'tool_available', trigger_llm: false });
  });

  it('道具が無ければ、何も置かない', () => {
    const { conv } = make();
    conv.announceStart();
    expect(conv.history.get()).toEqual([]);
  });
});

describe('EngineConversation — 添付', () => {
  it('置き場に OS の主体で書き、置いたパスを返す', async () => {
    const { conv, vfs } = make('eng-1');
    const path = await conv.putAttachment('shot.png', new Blob(['PNG']));
    expect(path).toBe('system/temp/engines/eng-1/shot.png');
    expect(vfs.files.get(path)).toBe('PNG');
    expect(vfs.writes).toEqual([{ by: 'system:kernel', path, system: true }]);
  });
});

describe('EngineConversation — 空にする', () => {
  it('消す前の会話を持ち主へ渡してから消し、会話の id を振り直す。添付の置き場は残す', async () => {
    const { conv, vfs, handed } = make('eng-1');
    const shot = await conv.putAttachment('shot.png', new Blob(['PNG']));
    conv.history.append('user', 'hello');
    const before = conv.currentId();

    const result = await conv.reset();

    expect(handed).toHaveLength(1);
    expect(handed[0].turnsAtCall).toBe(1);
    expect(handed[0].session).toMatchObject({ format: 'itera-session/1', id: before, title: '', turnCount: 1 });
    expect(handed[0].session.turns.map((t) => t.content)).toEqual(['hello']);
    expect(conv.history.get()).toEqual([]);
    expect(conv.currentId()).not.toBe(before);
    expect(result).toEqual({ archived: false, sessionId: conv.currentId() });
    expect(vfs.files.has(shot)).toBe(true);
    expect(vfs.deletes).toEqual([]);
  });

  it('道具の定義と申し送りを、OS のチャットと同じ文で置く。起こすかどうかは渡されたとおり', async () => {
    const { conv } = make('eng-1', { defs: [DEF] });
    conv.history.append('user', 'old');

    await conv.reset({ summary: 'carry', triggerLlm: true, restoreTools: true });
    expect(conv.history.get().map((t) => [t.content, t.meta.trigger_llm])).toEqual([
      [toolsRestoredEvent([DEF])!.content, false],
      [sessionResetEvent('carry', true).content, true],
    ]);

    // 道具の定義は頼まれたときだけ。起こすと言われなければ、起こさない
    await conv.reset({ summary: 'again' });
    expect(conv.history.get().map((t) => [t.content, t.meta.trigger_llm])).toEqual([
      [sessionResetEvent('again', false).content, false],
    ]);

    // 申し送りが無ければ、空のまま
    await conv.reset();
    expect(conv.history.get()).toEqual([]);
  });
});

describe('EngineConversation — 文書として出し入れする', () => {
  it('書いた会話を、別のエンジンが続きから始められる（添付ごと・会話の id も同じ）', async () => {
    const a = make('eng-a');
    const shot = await a.conv.putAttachment('shot.png', new Blob(['PNG']));
    a.conv.history.append('user', [media(shot)]);
    a.conv.history.append('model', 'seen');
    a.vfs.writes.length = 0;

    const saved = await a.conv.save('data/apps/x/conv-1/', APP);

    expect(saved).toEqual({ path: 'data/apps/x/conv-1', media: 1 });
    expect(a.vfs.files.get('data/apps/x/conv-1/media/shot.png')).toBe('PNG');
    expect(JSON.parse(a.vfs.files.get('data/apps/x/conv-1/session.json')!)).toMatchObject({
      format: 'itera-session/1',
      id: a.conv.currentId(),
      turnCount: 2,
    });
    // 保存先に書くのは、頼んだ者の主体
    expect(a.vfs.writes).toEqual([
      { by: 'app:viewer', path: 'data/apps/x/conv-1/session.json', system: false },
      { by: 'app:viewer', path: 'data/apps/x/conv-1/media/shot.png', system: false },
    ]);

    const b = make('eng-b', { vfs: a.vfs, defs: [DEF] });
    a.vfs.writes.length = 0;
    expect(await b.conv.load('data/apps/x/conv-1', APP)).toEqual({ ok: true });

    expect(b.conv.history.get().map((t) => [t.role, t.content])).toEqual([
      ['user', [media('system/temp/engines/eng-b/shot.png')]],
      ['model', 'seen'],
    ]);
    expect(a.vfs.files.get('system/temp/engines/eng-b/shot.png')).toBe('PNG');
    expect(a.vfs.writes).toEqual([{ by: 'system:kernel', path: 'system/temp/engines/eng-b/shot.png', system: true }]);
    expect(await b.conv.current()).toEqual(await a.conv.current());

    // 始まりの知らせは、読み込んだ印（最後に動いた時刻・道具の定義つき）。起こさない
    b.conv.announceStart();
    const mark = b.conv.history.get()[2];
    expect(mark.role).toBe('system');
    expect(mark.meta).toMatchObject({ eventType: 'session_loaded', trigger_llm: false });
    expect(mark.content).toContain('[System: Loaded a session from the VFS (last activity ');
    expect(mark.content).toContain(new Date(b.conv.history.get()[1].timestamp).toISOString());
    expect(mark.content).toContain(DEF);
  });

  it('読めなければ理由を返し、会話は空から始まる', async () => {
    const { conv, vfs } = make('eng-1', { defs: [DEF] });
    const before = conv.currentId();
    expect(await conv.load('data/apps/x/none', APP)).toEqual({ ok: false, detail: 'File not found: data/apps/x/none' });

    vfs.files.set('data/apps/x/bad/session.json', '{"format":"other"}');
    const bad = await conv.load('data/apps/x/bad', APP);
    expect(bad).toEqual({ ok: false, detail: 'unsupported format: "other"' });

    expect(conv.history.get()).toEqual([]);
    expect(conv.currentId()).toBe(before);
    conv.announceStart();
    expect(conv.history.get().map((t) => t.meta.eventType)).toEqual(['tool_available']);
  });

  it('同じ場所に書き直すと上書きし、添付は足りない分だけ足す', async () => {
    const { conv, vfs } = make('eng-1');
    await conv.putAttachment('a.png', new Blob(['A']));
    conv.history.append('user', 'one');
    expect(await conv.save('data/c', APP)).toEqual({ path: 'data/c', media: 1 });

    await conv.putAttachment('b.png', new Blob(['B']));
    conv.history.append('user', 'two');
    expect(await conv.save('data/c', APP)).toEqual({ path: 'data/c', media: 1 });

    expect(JSON.parse(vfs.files.get('data/c/session.json')!).turnCount).toBe(2);
    expect(vfs.files.get('data/c/media/a.png')).toBe('A');
    expect(vfs.files.get('data/c/media/b.png')).toBe('B');
  });

  it('空にしたあとの保存には、新しい会話だけが入る', async () => {
    const { conv, vfs } = make('eng-1');
    conv.history.append('user', 'old');
    const before = conv.currentId();
    await conv.reset({ summary: 'carry' });
    await conv.save('data/c', APP);
    const doc = JSON.parse(vfs.files.get('data/c/session.json')!);
    expect(doc.id).toBe(conv.currentId());
    expect(doc.id).not.toBe(before);
    expect(doc.turnCount).toBe(1);
  });
});

describe('EngineConversation — 畳む', () => {
  it('添付の置き場を消す（一時領域なので、ゴミ箱に入れない）', async () => {
    const { conv, vfs } = make('eng-1');
    await conv.putAttachment('a.png', new Blob(['A']));
    vfs.files.set('system/temp/engines/eng-2/keep.png', 'K');

    await conv.dispose();

    expect(vfs.deletes).toEqual([{ by: 'system:kernel', path: 'system/temp/engines/eng-1', permanent: true }]);
    expect([...vfs.files.keys()]).toEqual(['system/temp/engines/eng-2/keep.png']);
  });

  it('置き場が無ければ、何もしない', async () => {
    const { conv, vfs } = make('eng-1');
    await conv.dispose();
    expect(vfs.deletes).toEqual([]);
  });
});
