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

import { describe, it, expect } from 'vitest';
import { ToolRegistry } from './ToolRegistry';
import { registerSysTools } from './tools/sys_tools';
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
