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
import { registerSysTools } from './tools/sys_tools';
import { registerFSTools } from './tools/fs_tools';
import { ToolError } from './ToolError';
import { VfsError } from '../vfs/VfsError';
import { SessionManager } from '../../shell/services/SessionManager';

function registryWithTools() {
  const r = new ToolRegistry();
  registerSysTools(r);
  r.registerDynamicTool('autoexcel_write_cell', 'autoexcel', {
    description: 'write',
    definition: '<define_tag name="autoexcel_write_cell">Attr: cell. Content: value.</define_tag>',
  });
  r.registerDynamicTool('myaku_search_items', 'myaku_data_daemon', {
    description: 'search',
    definition: '<define_tag name="myaku_search_items">\nAttributes:\n  - query\n</define_tag>',
  });
  return r;
}

describe('ToolRegistry: 一覧と定義', () => {
  it('listToolSets は既定で動的な道具だけを、プロセスごとに返す', () => {
    const r = registryWithTools();
    const sets = r.listToolSets();
    expect(sets.map((s) => s.id).sort()).toEqual(['autoexcel', 'myaku_data_daemon']);
    expect(sets.every((s) => s.kind === 'dynamic')).toBe(true);
    const ax = sets.find((s) => s.id === 'autoexcel')!;
    expect(ax.tools).toEqual([{ name: 'autoexcel_write_cell', description: 'write', hasDefinition: true }]);
  });

  it('include_system でシステムの道具も出る（定義の本文は持たない）', () => {
    const r = registryWithTools();
    const sets = r.listToolSets(true);
    const sys = sets.find((s) => s.kind === 'system')!;
    expect(sys).toBeTruthy();
    expect(sys.tools.some((t) => t.name === 'tool_catalog')).toBe(true);
    expect(sys.tools.every((t) => t.hasDefinition === false)).toBe(true);
  });

  it('getToolDefinition は全文を返し、無ければ null', () => {
    const r = registryWithTools();
    const d = r.getToolDefinition('myaku_search_items')!;
    expect(d.setId).toBe('myaku_data_daemon');
    expect(d.definition).toContain('<define_tag name="myaku_search_items">');
    expect(r.getToolDefinition('nope')).toBeNull();
    // 解除すると消える
    r.unregisterDynamicTool('myaku_search_items', 'myaku_data_daemon');
    expect(r.getToolDefinition('myaku_search_items')).toBeNull();
  });
});

describe('tool_catalog（システムツール）', () => {
  it('list は一覧と、define の使い方を返す。戻りは次のターンを起こす（trigger_llm を false にしない）', async () => {
    const r = registryWithTools();
    const res = await r.execute({ type: 'tool_catalog', params: {} }, { shell: {}, engine: {} });
    // 2026-08-26: trigger_llm: false を付けていて、実行結果のあと AI が起きなかった（山内さんが踏んだ）
    expect(res!.trigger_llm).not.toBe(false);
    const def = await r.execute(
      { type: 'tool_catalog', params: { action: 'define', name: 'autoexcel_write_cell' } },
      { shell: {}, engine: {} },
    );
    expect(def!.trigger_llm).not.toBe(false);
    expect(res!.log).toContain('autoexcel_write_cell');
    expect(res!.log).toContain('pid: myaku_data_daemon');
    expect(res!.log).toContain('<tool_catalog action="define" name="TOOL_NAME" />');
    expect(res!.log).not.toContain('System: Core Logic');
  });

  it('define は <toolset> に包んだ定義の全文を返す。無い名前は誤りとして返す', async () => {
    const r = registryWithTools();
    const ok = await r.execute(
      { type: 'tool_catalog', params: { action: 'define', name: 'autoexcel_write_cell' } },
      { shell: {}, engine: {} },
    );
    expect(ok!.log).toContain('<toolset name=');
    expect(ok!.log).toContain('<define_tag name="autoexcel_write_cell">');
    const ng = await r.execute(
      { type: 'tool_catalog', params: { action: 'define', name: 'nope' } },
      { shell: {}, engine: {} },
    );
    expect(ng!.log).toContain('[Error]');
    const sys = await r.execute(
      { type: 'tool_catalog', params: { action: 'define', name: 'finish' } },
      { shell: {}, engine: {} },
    );
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
    const sm = new SessionManager(h.vfs, h.history, h.logger, registryWithTools());
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
    const sm = new SessionManager(h.vfs, h.history, h.logger, r);
    await sm.clearSession({ restoreTools: true });
    expect(h.appended.length).toBe(0);
  });
});

describe('ToolRegistry: 登録されていないタグ（T-0593）', () => {
  // 以前は UnknownToolError を投げていた。いまは他の失敗と同じく、失敗の結果を返す。
  it('未登録のタグは投げずに失敗の結果を返す', async () => {
    const r = registryWithTools();
    const res = await r.execute({ type: 'no_such_tool', params: {} }, { shell: {}, engine: {} });
    expect(res?.error).toBe(true);
    expect(res?.ui).toBe('❌ Error: Unknown tool <no_such_tool>');
    expect(res?.log).toContain('[LPML Syntax Violation]');
    expect(res?.log).toContain('<no_such_tool> is not registered');
  });

  it('OS しか出さないタグは、システム専用で機能しないと伝える', async () => {
    const r = registryWithTools();
    for (const tag of ['tool_output', 'event', 'system', 'toolset', 'user_input', 'user_attachment']) {
      const res = await r.execute({ type: tag, params: {} }, { shell: {}, engine: {} });
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
    const run = () => r.execute({ type: 't', params: { path: 'x' } }, { shell: {}, engine: {} });
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
    const vfs: any = {
      exists: (_p: any, path: string) => path === 'a.txt',
      stat: () => ({ kind: 'file', size: 5 }),
      readFile: async () => 'hello',
      writeFile: async () => 'ok',
    };
    const ctx = { shell: {}, engine: {}, vfs };
    const missing = await r.execute({ type: 'read_file', params: { path: 'nope.txt' } }, ctx);
    expect(missing?.error).toBe(true);
    expect(missing?.log).toContain('File not found');
    const mismatch = await r.execute(
      { type: 'edit_file', params: { path: 'a.txt', content: '<<<<<SEARCH\nbye\n=====\nciao\n>>>>>' } },
      ctx,
    );
    expect(mismatch?.error).toBe(true);
    expect(mismatch?.log).toContain('not found');
    expect(errors).not.toHaveBeenCalled();
  });

  it('dynamic: invoker が ToolError を投げれば（ゲストが返した error）赤を出さない。RPC の例外はそのまま赤', async () => {
    const h = harness();
    h.r.registerDynamicTool('g', 'guest_pid', { description: 'g' });
    const guestSaid = new ToolError('Tool handler not found: g');
    h.r.setGuestToolInvoker({ invokeTool: async () => Promise.reject(guestSaid) });
    const quiet = await h.r.execute({ type: 'g', params: {} }, { shell: {}, engine: {} });
    expect(quiet?.error).toBe(true);
    expect(quiet?.log).toBe('Error executing dynamic tool <g>: Tool handler not found: g');
    expect(h.errors).not.toHaveBeenCalled();

    h.r.setGuestToolInvoker({
      invokeTool: async () => Promise.reject(new Error('RPC Timeout: Request x exceeded 150000ms')),
    });
    const loud = await h.r.execute({ type: 'g', params: {} }, { shell: {}, engine: {} });
    expect(loud?.error).toBe(true);
    expect(loud?.log).toContain('RPC Timeout');
    expect(h.errors).toHaveBeenCalledTimes(1);
  });

  it('dynamic: ゲストが error: true の結果を返した（投げていない）場合は従来どおり結果のまま。赤も出ない', async () => {
    const h = harness();
    h.r.registerDynamicTool('g', 'guest_pid', { description: 'g' });
    h.r.setGuestToolInvoker({ invokeTool: async () => ({ log: '[Error] bad arg', error: true }) });
    const res = await h.r.execute({ type: 'g', params: {} }, { shell: {}, engine: {} });
    expect(res?.error).toBe(true);
    expect(res?.log).toBe('[Error] bad arg');
    expect(h.errors).not.toHaveBeenCalled();
    expect(h.records[0].status).toBe('error');
  });
});
