import { describe, it, expect, vi } from 'vitest';
import { CommandDispatcher } from './CommandDispatcher';

function harness(opts: { usage?: string } = {}) {
  const turns: any[] = [];
  const shown: any[] = [];
  const engine = { stop: vi.fn(), status: () => ({ running: false, busy: true, outstandingTools: 2 }) };
  const history = {
    get: () => turns,
    append: (role: string, content: any, meta: any) => {
      const t = { id: `t${turns.length}`, timestamp: 1000, role, content, meta };
      turns.push(t);
      return t;
    },
  };
  const sessionManager = {
    clearSession: vi.fn(async () => ({ archived: true, sessionId: 'n' })),
    currentSession: async () => ({ id: 's', title: 'T', createdAt: 0 }),
  };
  const processManager = { list: () => [{ pid: 'home', path: 'apps/home.html', type: 'app', state: 'foreground' }] };
  const files: Record<string, string> = {};
  if (opts.usage !== undefined) files['system/logs/usage/1970-01-01.jsonl'] = opts.usage;
  const vfs = {
    exists: (_p: any, path: string) => path in files,
    readFile: async (_p: any, path: string) => files[path],
  };
  const opened: string[] = [];
  const d = new CommandDispatcher({
    engine,
    history: history as any,
    sessionManager,
    processManager,
    vfs,
    open: (t) => opened.push(t),
    show: (t) => shown.push(t),
    now: () => 60000,
  });
  const lastText = () => turns[turns.length - 1]?.content as string;
  return { d, turns, shown, engine, sessionManager, opened, lastText };
}

describe('CommandDispatcher', () => {
  it('通常の発言と // は手を出さない', async () => {
    const h = harness();
    expect(await h.d.tryDispatch('/tmp/x を見て')).toEqual({ handled: false, text: '/tmp/x を見て' });
    expect(await h.d.tryDispatch('//help')).toEqual({ handled: false, text: '/help' });
    expect(h.turns).toEqual([]);
  });

  it('結果は command の system ターンとして置き、画面にも出し、LLM は起こさない', async () => {
    const h = harness();
    expect(await h.d.tryDispatch('/help')).toEqual({ handled: true });
    expect(h.turns).toHaveLength(1);
    expect(h.turns[0].meta).toEqual({ type: 'event_log', eventType: 'command', trigger_llm: false });
    expect(h.lastText()).toMatch(/^<event type="command">\n\$ \/help\n/);
    expect(h.lastText()).toContain('/status');
    expect(h.shown).toEqual([h.turns[0]]);
  });

  it('/status は engine・会話・usage ログの直近を 3 行で', async () => {
    const h = harness({
      usage: JSON.stringify({
        timestamp: 'x',
        model: 'm',
        tokens: { input: 1000, cached: 500, cacheWrite: 0, output: 1 },
      }),
    });
    await h.d.tryDispatch('/status');
    const t = h.lastText();
    expect(t).toContain('engine: idle / busy (tools in flight: 2)');
    expect(t).toContain('session: "T", 0 turns');
    expect(t).toContain('context: 1,500 tokens in (m, x; lags one turn)');
  });

  it('/status はログが無ければ unknown（推測値を出さない）', async () => {
    const h = harness();
    await h.d.tryDispatch('/status');
    expect(h.lastText()).toContain('context: unknown');
  });

  it('/stop は engine を止める', async () => {
    const h = harness();
    await h.d.tryDispatch('/stop');
    expect(h.engine.stop).toHaveBeenCalledTimes(1);
    expect(h.lastText()).toContain('Stopped.');
  });

  it('/reset は stop → clearSession（申し送りを運び、起こす）。結果のターンは置かない（新しい会話を汚さない）', async () => {
    const h = harness();
    await h.d.tryDispatch('/reset T-0633 を見張る');
    expect(h.engine.stop).toHaveBeenCalledTimes(1);
    expect(h.sessionManager.clearSession).toHaveBeenCalledWith({
      summary:
        '[System: Session reset by user command]\nPlease run the Initialization Protocol first.\n\n[Carried Over Information]\nT-0633 を見張る',
      triggerLlm: true,
      restoreTools: true,
    });
    expect(h.turns).toEqual([]);
  });

  it('/ps は一覧、/open は開く。引数なしの /open は失敗として記録', async () => {
    const h = harness();
    await h.d.tryDispatch('/ps');
    expect(h.lastText()).toContain('home  app     foreground  apps/home.html');
    await h.d.tryDispatch('/open metaos://system/settings');
    expect(h.opened).toEqual(['metaos://system/settings']);
    await h.d.tryDispatch('/open');
    expect(h.lastText()).toContain('[Error] usage: /open <path>');
  });

  it('実行の例外は [Error] として記録され、呼び手には handled で返る', async () => {
    const h = harness();
    h.d.register({
      name: 'boom',
      usage: '/boom',
      summary: 'x',
      run: async () => {
        throw new Error('bang');
      },
    });
    expect(await h.d.tryDispatch('/boom')).toEqual({ handled: true });
    expect(h.lastText()).toContain('[Error] bang');
    expect(() =>
      h.d.register({ name: 'HELP', usage: '', summary: '', run: async () => ({ ok: true, text: '' }) }),
    ).toThrow();
  });
});
