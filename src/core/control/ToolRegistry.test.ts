/**
 * src/core/control/ToolRegistry.test.ts
 * 道具の定義を AI が自分で取りに来られること（T-0246）
 *
 * 背景:
 *   道具の定義は登録時に <event type="tool_available"> で履歴に積まれるだけだった。
 *   利用者が履歴を消すと定義は消え、AI は「知らない道具がある」ことに気づけない。
 *   守りたいのは 3 点:
 *     1. 履歴の消去でも、リセット時と同じ「Restored Dynamic Tools」が積まれる（SessionManager）
 *     2. 一覧（listToolSets）は動的な道具だけを既定で返し、システムは include_system で出る
 *     3. 1 本の定義（getToolDefinition）は <define_tag> の全文を返し、無ければ null
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { ToolRegistry } from './ToolRegistry';
import { ROOT_ENGINE_ID } from './Engine';
import { registerSysTools } from './tools/sys_tools';
import { registerFSTools } from './tools/fs_tools';
import { ToolError } from './ToolError';
import { VfsError } from '../vfs/VfsError';
import { SessionManager } from '../../shell/services/SessionManager';
import type { ToolContext } from './ToolContext';

/** 道具が文脈を使わない場面のための、空の文脈（型だけ合わせる） */
const NO_CTX = { shell: {}, engine: {} } as unknown as ToolContext;
/** ルートのエンジンから見える口（道具を探す・呼ぶ・登録するのは、どれも口を通す。T-0903） */
const v = (r: ToolRegistry) => r.viewFor(ROOT_ENGINE_ID);
/** tool_catalog のための文脈（一覧は文脈の口から読む） */
const ctxOf = (r: ToolRegistry) => ({ ...NO_CTX, tools: v(r) }) as ToolContext;

function registryWithTools() {
  const r = new ToolRegistry();
  registerSysTools(r);
  v(r).registerDynamicTool('autoexcel_write_cell', 'autoexcel', {
    description: 'write',
    definition: '<define_tag name="autoexcel_write_cell">Attr: cell. Content: value.</define_tag>',
  });
  v(r).registerDynamicTool('myaku_search_items', 'myaku_data_daemon', {
    description: 'search',
    definition: '<define_tag name="myaku_search_items">\nAttributes:\n  - query\n</define_tag>',
  });
  return r;
}

describe('ToolRegistry: 一覧と定義', () => {
  it('listToolSets は既定で動的な道具だけを、プロセスごとに返す', () => {
    const r = registryWithTools();
    const sets = v(r).listToolSets();
    expect(sets.map((s) => s.id).sort()).toEqual(['autoexcel', 'myaku_data_daemon']);
    expect(sets.every((s) => s.kind === 'dynamic')).toBe(true);
    const ax = sets.find((s) => s.id === 'autoexcel')!;
    expect(ax.tools).toEqual([{ name: 'autoexcel_write_cell', description: 'write', hasDefinition: true }]);
  });

  it('include_system でシステムの道具も出る（定義の本文は持たない）', () => {
    const r = registryWithTools();
    const sets = v(r).listToolSets(true);
    const sys = sets.find((s) => s.kind === 'system')!;
    expect(sys).toBeTruthy();
    expect(sys.tools.some((t) => t.name === 'tool_catalog')).toBe(true);
    expect(sys.tools.every((t) => t.hasDefinition === false)).toBe(true);
  });

  it('getToolDefinition は全文を返し、無ければ null', () => {
    const r = registryWithTools();
    const d = v(r).getToolDefinition('myaku_search_items')!;
    expect(d.setId).toBe('myaku_data_daemon');
    expect(d.definition).toContain('<define_tag name="myaku_search_items">');
    expect(v(r).getToolDefinition('nope')).toBeNull();
    // 解除すると消える
    v(r).unregisterDynamicTool('myaku_search_items', 'myaku_data_daemon');
    expect(v(r).getToolDefinition('myaku_search_items')).toBeNull();
  });
});

describe('tool_catalog（システムツール）', () => {
  it('list は一覧と、define の使い方を返す。戻りは次のターンを起こす（trigger_llm を false にしない）', async () => {
    const r = registryWithTools();
    const res = await v(r).execute({ type: 'tool_catalog', params: {} }, ctxOf(r));
    // 2026-08-26: trigger_llm: false を付けていて、実行結果のあと AI が起きなかった（山内さんが踏んだ）
    expect(res!.trigger_llm).not.toBe(false);
    const def = await v(r).execute(
      { type: 'tool_catalog', params: { action: 'define', name: 'autoexcel_write_cell' } },
      ctxOf(r),
    );
    expect(def!.trigger_llm).not.toBe(false);
    expect(res!.log).toContain('autoexcel_write_cell');
    expect(res!.log).toContain('pid: myaku_data_daemon');
    expect(res!.log).toContain('<tool_catalog action="define" name="TOOL_NAME" />');
    expect(res!.log).not.toContain('System: Core Logic');
  });

  it('define は <toolset> に包んだ定義の全文を返す。無い名前は誤りとして返す', async () => {
    const r = registryWithTools();
    const ok = await v(r).execute(
      { type: 'tool_catalog', params: { action: 'define', name: 'autoexcel_write_cell' } },
      ctxOf(r),
    );
    expect(ok!.log).toContain('<toolset name=');
    expect(ok!.log).toContain('<define_tag name="autoexcel_write_cell">');
    const ng = await v(r).execute({ type: 'tool_catalog', params: { action: 'define', name: 'nope' } }, ctxOf(r));
    expect(ng!.log).toContain('[Error]');
    const sys = await v(r).execute({ type: 'tool_catalog', params: { action: 'define', name: 'finish' } }, ctxOf(r));
    expect(sys!.log).toContain('system prompt');
  });
});

describe('SessionManager: 履歴の消去でも道具の定義を積み直す', () => {
  function harness() {
    const appended: Array<{ role: string; content: string; meta: any }> = [];
    let cleared = 0;
    // 退避の口（T-0613）は空の会話として応える。退避そのものの試験は SessionManager.test.ts
    const history: any = {
      clear: () => cleared++,
      append: (role: string, content: string, meta: any) => appended.push({ role, content, meta }),
      get: () => [],
      getCurrentMeta: async () => undefined,
      setCurrentMeta: async () => {},
      getSessionsIndex: async () => [],
      setSessionsIndex: async () => {},
      putSession: async () => {},
      deleteSession: async () => {},
    };
    const vfs: any = { exists: () => false, deleteFile: async () => {} };
    const logger: any = { log: () => {} };
    return { appended, history, vfs, logger, clearedCount: () => cleared };
  }

  it('restoreTools: true で「Restored Dynamic Tools」が積まれ、AI は起こさない', async () => {
    const h = harness();
    const sm = new SessionManager(h.vfs, h.history, h.history, h.logger, v(registryWithTools()));
    await sm.clearSession({ triggerLlm: false, restoreTools: true });
    expect(h.clearedCount()).toBe(1);
    const restored = h.appended.find((a) => a.content.includes('[System: Restored Dynamic Tools]'))!;
    expect(restored).toBeTruthy();
    expect(restored.content).toContain('<define_tag name="autoexcel_write_cell">');
    expect(restored.meta.type).toBe('tool_available');
    expect(restored.meta.trigger_llm).toBe(false);
  });

  it('動的な道具が無ければ何も積まない', async () => {
    const h = harness();
    const r = new ToolRegistry();
    registerSysTools(r);
    const sm = new SessionManager(h.vfs, h.history, h.history, h.logger, v(r));
    await sm.clearSession({ restoreTools: true });
    expect(h.appended.length).toBe(0);
  });
});

describe('ToolRegistry: 登録されていないタグ（T-0593）', () => {
  // 以前は UnknownToolError を投げていた。いまは他の失敗と同じく、失敗の結果を返す。
  it('未登録のタグは投げずに失敗の結果を返す', async () => {
    const r = registryWithTools();
    const res = await v(r).execute({ type: 'no_such_tool', params: {} }, NO_CTX);
    expect(res?.error).toBe(true);
    expect(res?.ui).toBe('❌ Error: Unknown tool <no_such_tool>');
    expect(res?.log).toContain('[LPML Syntax Violation]');
    expect(res?.log).toContain('<no_such_tool> is not registered');
  });

  it('OS しか出さないタグは、システム専用で機能しないと伝える', async () => {
    const r = registryWithTools();
    for (const tag of ['tool_output', 'event', 'system', 'toolset', 'user_input', 'user_attachment']) {
      const res = await v(r).execute({ type: tag, params: {} }, NO_CTX);
      expect(res?.error).toBe(true);
      expect(res?.ui).toBe(`❌ Error: <${tag}> is reserved for the OS`);
      expect(res?.log).toContain('[LPML Protocol Violation]');
      expect(res?.log).toContain('NOT executed');
    }
  });
});

describe('ToolRegistry: 失敗のログの出し分け（T-0677）', () => {
  // ツールの契約上の答え（SEARCH 不一致・ファイル無し・属性の欠け）は、結果の error: true と tool_events に残れば足りる。
  // コンソールに赤で出すのは実装の例外だけ。両方が同じ赤で出ていたので、OS の不具合と AI の入力の誤りが見分けられなかった。
  function harness() {
    const records: any[] = [];
    const r = new ToolRegistry(undefined, { record: (e: any) => records.push(e) } as any);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'debug').mockImplementation(() => {});
    const impl = (fn: () => Promise<any>) =>
      r.registerSystemTool('system:test', 'Test', { name: 't', description: '', impl: fn });
    const run = () => v(r).execute({ type: 't', params: { path: 'x' } }, NO_CTX);
    return { r, records, errors, impl, run };
  }
  afterEach(() => vi.restoreAllMocks());

  it('system: ToolError は console.error を呼ばない。結果は error: true、tool_events には name と message が残る', async () => {
    const h = harness();
    h.impl(async () => {
      throw new ToolError('Search pattern not found in block 1.');
    });
    const res = await h.run();
    expect(res?.error).toBe(true);
    expect(res?.log).toBe('Error executing <t>: Search pattern not found in block 1.');
    expect(h.errors).not.toHaveBeenCalled();
    expect(h.records[0].status).toBe('error');
    expect(h.records[0].error).toMatchObject({ name: 'ToolError', message: 'Search pattern not found in block 1.' });
  });

  it('system: VFS の拒否（VfsError）も期待される失敗。ToolError に包まれ、code が tool_events に残る', async () => {
    const h = harness();
    h.impl(async () => {
      throw new VfsError('ENOENT', 'File not found: memory/journals/2026-10-19.md');
    });
    const res = await h.run();
    expect(res?.error).toBe(true);
    expect(res?.ui).toBe('❌ Error: File not found: memory/journals/2026-10-19.md');
    expect(h.errors).not.toHaveBeenCalled();
    expect(h.records[0].error).toMatchObject({ name: 'ToolError', code: 'ENOENT' });
  });

  it('system: それ以外の例外（実装の欠陥）は console.error を呼ぶ。結果の形は同じ', async () => {
    const h = harness();
    h.impl(async () => {
      throw new TypeError("Cannot read properties of undefined (reading 'split')");
    });
    const res = await h.run();
    expect(res?.error).toBe(true);
    expect(res?.log).toContain("Cannot read properties of undefined (reading 'split')");
    expect(h.errors).toHaveBeenCalledTimes(1);
    expect(String(h.errors.mock.calls[0][0])).toContain('Error executing system tool <t>');
    expect(h.records[0].error).toMatchObject({ name: 'TypeError' });
  });

  it('system: 実際のツール — 無いファイルの read_file と、一致しない SEARCH の edit_file は赤を出さない', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'debug').mockImplementation(() => {});
    const r = new ToolRegistry();
    registerFSTools(r);
    const fs: any = {
      exists: (path: string) => path === 'a.txt',
      stat: () => ({ kind: 'file', size: 5 }),
      readFile: async () => 'hello',
      writeFile: async () => 'ok',
      // edit は版の照合の輪（updateFile）を通る（T-0715）。fn の例外（一致しない）はそのまま出る
      updateFile: async (_path: string, fn: (c: string, v: number) => string | null) => {
        await fn('hello', 1);
        return { message: 'ok', version: 2, attempts: 1 };
      },
    };
    const ctx = { ...NO_CTX, fs } as ToolContext;
    const missing = await v(r).execute({ type: 'read_file', params: { path: 'nope.txt' } }, ctx);
    expect(missing?.error).toBe(true);
    expect(missing?.log).toContain('File not found');
    const mismatch = await v(r).execute(
      { type: 'edit_file', params: { path: 'a.txt', content: '<<<<<SEARCH\nbye\n=====\nciao\n>>>>>' } },
      ctx,
    );
    expect(mismatch?.error).toBe(true);
    expect(mismatch?.log).toContain('not found');
    expect(errors).not.toHaveBeenCalled();
  });

  it('dynamic: invoker が ToolError を投げれば（ゲストが返した error）赤を出さない。RPC の例外はそのまま赤', async () => {
    const h = harness();
    v(h.r).registerDynamicTool('g', 'guest_pid', { description: 'g' });
    const guestSaid = new ToolError('Tool handler not found: g');
    h.r.setGuestToolInvoker({ invokeTool: async () => Promise.reject(guestSaid) });
    const quiet = await v(h.r).execute({ type: 'g', params: {} }, NO_CTX);
    expect(quiet?.error).toBe(true);
    expect(quiet?.log).toBe('Error executing dynamic tool <g>: Tool handler not found: g');
    expect(h.errors).not.toHaveBeenCalled();

    h.r.setGuestToolInvoker({
      invokeTool: async () => Promise.reject(new Error('RPC Timeout: Request x exceeded 150000ms')),
    });
    const loud = await v(h.r).execute({ type: 'g', params: {} }, NO_CTX);
    expect(loud?.error).toBe(true);
    expect(loud?.log).toContain('RPC Timeout');
    expect(h.errors).toHaveBeenCalledTimes(1);
  });

  it('dynamic: ゲストが error: true の結果を返した（投げていない）場合は従来どおり結果のまま。赤も出ない', async () => {
    const h = harness();
    v(h.r).registerDynamicTool('g', 'guest_pid', { description: 'g' });
    h.r.setGuestToolInvoker({ invokeTool: async () => ({ log: '[Error] bad arg', error: true }) });
    const res = await v(h.r).execute({ type: 'g', params: {} }, NO_CTX);
    expect(res?.error).toBe(true);
    expect(res?.log).toBe('[Error] bad arg');
    expect(h.errors).not.toHaveBeenCalled();
    expect(h.records[0].status).toBe('error');
  });
});
describe('ToolRegistry: 閉じていない要素は実行しない（T-0878）', () => {
  // LPML で実行されるのは閉じた要素だけ。閉じていないアクションは、道具を呼ばずに失敗の結果として返す
  // （未登録のタグと同じ経路。モデルは次のターンで、どのタグが実行されなかったかを読める）。
  function harness() {
    const records: any[] = [];
    const r = new ToolRegistry(undefined, { record: (e: any) => records.push(e) } as any);
    const impl = vi.fn(async () => ({ log: 'done' }));
    r.registerSystemTool('system:test', 'Test', { name: 'write', description: 'w', impl });
    return { r, impl, records };
  }
  const ctx = NO_CTX;

  it('closed: false のアクションは道具を呼ばず、失敗の結果を返す', async () => {
    const h = harness();
    const res = await v(h.r).execute(
      { type: 'write', params: { path: 'a.txt', content: 'partial' }, closed: false },
      ctx,
    );
    expect(h.impl).not.toHaveBeenCalled();
    expect(res?.error).toBe(true);
    expect(res?.ui).toBe('❌ Error: <write> was not closed');
    expect(res?.log).toContain('<write> was not closed, so it was not executed');
    expect(res?.log).toContain('</' + 'write>');
    expect(res?.log).toContain('<write ... />');
  });

  it('閉じているアクションと、closed を持たない呼び出しは従来どおり実行する', async () => {
    const h = harness();
    expect((await v(h.r).execute({ type: 'write', params: { path: 'a.txt' }, closed: true }, ctx))?.log).toBe('done');
    expect((await v(h.r).execute({ type: 'write', params: { path: 'a.txt' } }, ctx))?.log).toBe('done');
    expect(h.impl).toHaveBeenCalledTimes(2);
  });

  it('登録の有無より先に見る（未登録・システム専用のタグでも「閉じていない」と答える）', async () => {
    const h = harness();
    for (const type of ['no_such_tool', 'tool_output', 'memo']) {
      const res = await v(h.r).execute({ type, params: {}, closed: false }, ctx);
      expect(res?.error).toBe(true);
      expect(res?.ui).toBe(`❌ Error: <${type}> was not closed`);
    }
  });

  it('実行の記録（tool_events）には失敗として残る', async () => {
    const h = harness();
    await v(h.r).execute({ type: 'write', params: { path: 'a.txt' }, closed: false }, ctx);
    expect(h.impl).not.toHaveBeenCalled();
    expect(h.records).toHaveLength(1);
    expect(h.records[0].status).toBe('error');
    expect(h.records[0].engine).toBe(ROOT_ENGINE_ID);
  });
});
describe('ToolRegistry: エンジンごとの台帳（T-0903）', () => {
  // システムの道具は 1 組を全エンジンが共有し、動的な道具は「登録したプロセスが仕えるエンジン」の台帳に入る。
  // エンジンに見えるのは システムの道具 → 自分の台帳 → 口を作るときに並べたほかの台帳。
  function harness() {
    const records: any[] = [];
    const r = new ToolRegistry(undefined, { record: (e: any) => records.push(e) } as any);
    registerSysTools(r);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const calls: Array<{ pid: string; name: string }> = [];
    r.setGuestToolInvoker({
      invokeTool: async (pid: string, name: string) => {
        calls.push({ pid, name });
        return `${pid}:${name}`;
      },
    });
    const root = r.viewFor(ROOT_ENGINE_ID);
    const sub = r.viewFor('e1', [ROOT_ENGINE_ID]);
    root.registerDynamicTool('search', 'web_daemon', {
      description: 's',
      definition: '<define_tag name="search">root</define_tag>',
    });
    sub.registerDynamicTool('draw', 'canvas_2', {
      description: 'd',
      definition: '<define_tag name="draw">sub</define_tag>',
    });
    return { r, root, sub, records, calls };
  }
  afterEach(() => vi.restoreAllMocks());

  it('登録は自分の台帳に入る。見えるのは自分の台帳と、その後ろに並べた台帳だけ', () => {
    const h = harness();
    expect(h.root.getRegisteredToolNames()).toContain('search');
    expect(h.root.getRegisteredToolNames()).not.toContain('draw');
    expect(h.root.getToolDefinition('draw')).toBeNull();

    expect(h.sub.getRegisteredToolNames()).toEqual(expect.arrayContaining(['draw', 'search']));
    expect(h.sub.listToolSets().map((s) => s.id)).toEqual(['canvas_2', 'web_daemon']);
    expect(h.sub.getToolDefinition('search')?.setId).toBe('web_daemon');
    expect(h.sub.getActiveDynamicToolDefinitions().join('\n')).toContain('<define_tag name="search">root</define_tag>');

    // 何も並べなかった口には、ほかのエンジンの道具は見えない
    const alone = h.r.viewFor('e2');
    expect(alone.listToolSets()).toEqual([]);
    expect(alone.getRegisteredToolNames()).toContain('finish');
  });

  it('システムの道具は、どの口からも同じ 1 組', () => {
    const h = harness();
    const systemOf = (view: typeof h.root) =>
      view
        .listToolSets(true)
        .filter((s) => s.kind === 'system')
        .map((s) => [s.id, s.tools.map((t) => t.name)]);
    expect(systemOf(h.sub)).toEqual(systemOf(h.root));
    expect(systemOf(h.root).length).toBeGreaterThan(0);
  });

  it('同じ名前が両方に在れば、自分の台帳のものが動く。ルートからはルートのものが動く', async () => {
    const h = harness();
    h.sub.registerDynamicTool('search', 'my_search', { description: 'mine' });
    expect((await h.sub.execute({ type: 'search', params: {} }, NO_CTX))?.log).toBe('my_search:search');
    expect((await h.root.execute({ type: 'search', params: {} }, NO_CTX))?.log).toBe('web_daemon:search');
    expect(h.calls).toEqual([
      { pid: 'my_search', name: 'search' },
      { pid: 'web_daemon', name: 'search' },
    ]);
  });

  it('実行の記録には、呼んだエンジンの id が付く（道具の持ち主が別のエンジンに仕えていても）', async () => {
    const h = harness();
    await h.sub.execute({ type: 'search', params: {} }, NO_CTX);
    await h.root.execute({ type: 'search', params: {} }, NO_CTX);
    await h.sub.execute({ type: 'finish', params: {} }, NO_CTX);
    await h.sub.execute({ type: 'no_such_tool', params: {} }, NO_CTX);
    expect(h.records.map((e) => [e.tool, e.engine, e.kind, e.sourcePid])).toEqual([
      ['search', 'e1', 'dynamic', 'web_daemon'],
      ['search', ROOT_ENGINE_ID, 'dynamic', 'web_daemon'],
      ['finish', 'e1', 'system', undefined],
      ['no_such_tool', 'e1', 'unknown', undefined],
    ]);
  });

  it('ルートの口から、ほかのエンジンの道具は呼べない（未登録として返る）', async () => {
    const h = harness();
    const res = await h.root.execute({ type: 'draw', params: {} }, NO_CTX);
    expect(res?.error).toBe(true);
    expect(res?.log).toContain('<draw> is not registered');
    expect(h.calls).toEqual([]);
  });

  it('解除は自分の台帳だけに効く（後ろに見えているだけの道具は外せない）', () => {
    const h = harness();
    h.sub.unregisterDynamicTool('search', 'web_daemon');
    expect(h.root.getRegisteredToolNames()).toContain('search');
    expect(h.sub.getRegisteredToolNames()).toContain('search');
    h.sub.unregisterDynamicTool('draw', 'canvas_2');
    expect(h.sub.getRegisteredToolNames()).not.toContain('draw');
  });

  it('プロセスが終われば、どの台帳に在ってもその組は消える', () => {
    const h = harness();
    h.r.removeToolsByPid('canvas_2');
    expect(h.sub.getRegisteredToolNames()).not.toContain('draw');
    expect(h.sub.getRegisteredToolNames()).toContain('search');
    h.r.removeToolsByPid('web_daemon');
    expect(h.sub.getRegisteredToolNames()).not.toContain('search');
    expect(h.root.getRegisteredToolNames()).not.toContain('search');
  });

  it('口を畳むと、そのエンジンの台帳だけが消える', () => {
    const h = harness();
    h.sub.dispose();
    const again = h.r.viewFor('e1', [ROOT_ENGINE_ID]);
    expect(again.getRegisteredToolNames()).not.toContain('draw');
    expect(again.getRegisteredToolNames()).toContain('search');
    expect(h.root.getRegisteredToolNames()).toContain('search');
  });
});
