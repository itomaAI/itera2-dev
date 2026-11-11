/**
 * MetaOS.chat の規則（T-0634）。ホストの実体に触らない純関数の試験。
 */
import { describe, it, expect } from 'vitest';
import {
  buildAppendPlan,
  buildResetPlan,
  contextFromHistory,
  CONTEXT_RECENT_MAX,
  formatChatStatus,
  buildChatStatus,
  mimeOfAttachment,
  resolveAttachments,
  attachmentPathsOf,
} from './chatApi';

describe('chat.append の計画', () => {
  it('文字列は user の text 1 つになり、既定では起こさない・画面に出す', () => {
    const p = buildAppendPlan({ role: 'user', content: 'hi' }, 'telegram_daemon');
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(p.role).toBe('user');
    expect(p.content).toEqual([{ text: 'hi' }]);
    expect(p.meta).toEqual({ trigger_llm: false, source: 'telegram_daemon' });
    expect(p.wake).toBe(false);
    expect(p.visible).toBe(true);
  });

  it('system は event_log になり、eventType の既定は app_event', () => {
    const p = buildAppendPlan({ role: 'system', content: 'x', opts: { wake: true } }, 'loom_daemon');
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(p.meta).toEqual({ trigger_llm: true, source: 'loom_daemon', type: 'event_log', eventType: 'app_event' });
    const q = buildAppendPlan(
      { role: 'system', content: 'x', opts: { eventType: 'system_task', visible: false } },
      'a',
    );
    if (!q.ok) throw new Error(q.reason);
    expect(q.meta.eventType).toBe('system_task');
    expect(q.meta.visible).toBe(false);
    expect(q.visible).toBe(false);
  });

  it('添付は ai:ask と同じ並び（media 全部 → 注記 全部 → 本文）。判定を渡さなければ中身は読まない', () => {
    const p = buildAppendPlan({ role: 'user', content: 'see', opts: { attachments: ['a/b.png', 'c.txt'] } }, 'x');
    if (!p.ok) throw new Error(p.reason);
    expect(p.content).toEqual([
      { media: { path: 'a/b.png', mimeType: 'image/png', metadata: {} } },
      {
        text: '<user_attachment name="b.png" path="a/b.png" bytes="0">[Binary File: b.png (image/png, 0 B)]</user_attachment>',
      },
      {
        text: '<user_attachment name="c.txt" path="c.txt" bytes="0" truncated="true">[Text file not expanded: its content could not be read. Use <read> on the path.]</user_attachment>',
      },
      { text: 'see' },
    ]);
  });

  it('文字の添付は門を通して先頭だけ本文に展開する（resolveAttachments → buildAppendPlan）', async () => {
    const files: Record<string, string> = { 'notes/a.md': '# title\nbody', 'x/big.csv': 'h\n1\n2\n3\n' };
    const resolved = await resolveAttachments(['notes/a.md', 'img.webp', 'x/big.csv', 'missing.txt'], async (path) => {
      if (!(path in files)) throw new Error('not found');
      const bytes = new TextEncoder().encode(files[path]);
      return { size: bytes.length, bytes: async () => bytes };
    });
    expect(resolved.map((r) => r.decision.route)).toEqual(['inline', 'media', 'inline', 'reference']);
    const p = buildAppendPlan({ role: 'user', content: 'see', opts: { attachments: ['ignored'] } }, 'x', resolved);
    if (!p.ok) throw new Error(p.reason);
    expect(p.content[0]).toEqual({ media: { path: 'img.webp', mimeType: 'image/webp', metadata: {} } });
    expect(p.content[1]).toEqual({
      text: '<user_attachment name="a.md" path="notes/a.md" lines="2" bytes="12">\n# title\nbody\n</user_attachment>',
    });
    expect((p.content[2] as any).text).toContain('[Binary File: img.webp (image/webp, 0 B)]');
    expect((p.content[3] as any).text).toContain('lines="4"');
    expect((p.content[4] as any).text).toContain('could not be read');
    expect(p.content[5]).toEqual({ text: 'see' });
    expect(attachmentPathsOf({ attachments: ['a', '', 3, 'b'] })).toEqual(['a', 'b']);
    expect(attachmentPathsOf(null)).toEqual([]);
  });

  it('parts の配列は text と media だけを受け、media の mimeType は無ければ拡張子から', () => {
    const p = buildAppendPlan(
      {
        role: 'user',
        content: [{ text: 'a' }, { media: { path: 'p.jpg' } }, { media: { path: 'q.bin', mimeType: 'x/y' } }],
      },
      'x',
    );
    if (!p.ok) throw new Error(p.reason);
    expect(p.content).toEqual([
      { text: 'a' },
      { media: { path: 'p.jpg', mimeType: 'image/jpeg', metadata: {} } },
      { media: { path: 'q.bin', mimeType: 'x/y', metadata: {} } },
    ]);
    expect(buildAppendPlan({ role: 'user', content: [{ foo: 1 }] }, 'x')).toMatchObject({ ok: false });
    expect(buildAppendPlan({ role: 'user', content: 42 }, 'x')).toMatchObject({ ok: false });
  });

  it('役割が user / system 以外、または中身が空なら断る', () => {
    expect(buildAppendPlan({ role: 'model', content: 'x' }, 'x')).toMatchObject({ ok: false });
    expect(buildAppendPlan({ role: 'user', content: '' }, 'x')).toMatchObject({
      ok: false,
      reason: 'content is empty',
    });
    expect(buildAppendPlan({ role: 'user', content: [] }, 'x')).toMatchObject({ ok: false });
    // 添付だけなら中身がある
    expect(buildAppendPlan({ role: 'user', content: '', opts: { attachments: ['a.png'] } }, 'x')).toMatchObject({
      ok: true,
    });
  });

  it('MIME はパスから（画像と PDF は正しい種別、文字の候補は text/plain、他は octet-stream）', () => {
    expect(mimeOfAttachment('x.webp')).toBe('image/webp');
    expect(mimeOfAttachment('x.png')).toBe('image/png');
    expect(mimeOfAttachment('x.pdf')).toBe('application/pdf');
    expect(mimeOfAttachment('x.md')).toBe('text/plain');
    expect(mimeOfAttachment('x.zip')).toBe('application/zip');
    expect(mimeOfAttachment('x.bin')).toBe('application/octet-stream');
  });
});

describe('chat.reset の計画', () => {
  it('既定は道具を積み直す。summary の頭に呼び手と起動手順の促し（起こす旗は無い —— reset は起こさない）', () => {
    const p = buildResetPlan(undefined, 'telegram_daemon');
    expect(p).not.toHaveProperty('wake');
    expect(p.restoreTools).toBe(true);
    expect(p.summary).toBe('[System: Session reset by telegram_daemon]\nPlease run the Initialization Protocol first.');
  });
  it('申し送りは Carried Over Information として続く。restoreTools は false にできる', () => {
    const p = buildResetPlan({ summary: '  T-0633 を見張る  ', restoreTools: false }, 'x');
    expect(p.summary.endsWith('\n\n[Carried Over Information]\nT-0633 を見張る')).toBe(true);
    expect(p.restoreTools).toBe(false);
  });
});

describe('文脈の長さ（履歴から）', () => {
  const model = (timestamp: number, usage: any, extra: any = {}) => ({
    id: `m${timestamp}`,
    timestamp,
    role: 'model' as const,
    content: 'y',
    meta: { ...(usage === undefined ? {} : { usage }), ...extra },
  });
  const user = (timestamp: number) => ({
    id: `u${timestamp}`,
    timestamp,
    role: 'user' as const,
    content: 'x',
    meta: {},
  });
  const at = (ms: number) => new Date(ms).toISOString();

  it('最後の usage を持つ model ターンから読み、長さは input＋cached＋cacheWrite', () => {
    const turns = [
      user(1),
      model(2, { input: 10, cached: 5, cacheWrite: 1, output: 3, total: 19 }, { model: 'old' }),
      user(3),
      model(4, { input: 100, cached: 50, cacheWrite: 7, output: 9, total: 166 }, { model: 'm' }),
      user(5),
    ];
    expect(contextFromHistory(turns, 200000)).toEqual({
      tokens: 157,
      output: 9,
      model: 'm',
      at: at(4),
      limit: 200000,
      recent: [
        { at: at(4), tokens: 157, output: 9 },
        { at: at(2), tokens: 16, output: 3 },
      ],
    });
  });

  it('usage を持たない model ターン（失敗・中断・古い履歴）は飛ばす', () => {
    const turns = [
      model(1, { input: 40, cached: 0, cacheWrite: 0, output: 2, total: 42 }, { model: 'm' }),
      model(2, undefined, { status: 'error' }),
      model(3, null),
      model(4, 'broken'),
    ];
    const c = contextFromHistory(turns, null);
    expect(c?.tokens).toBe(40);
    expect(c?.at).toBe(at(1));
    expect(c?.limit).toBeNull();
    expect(c?.recent).toHaveLength(1);
  });

  it('model 以外のターンの meta.usage は見ない', () => {
    const turns = [{ id: 's', timestamp: 1, role: 'system' as const, content: 'x', meta: { usage: { input: 5 } } }];
    expect(contextFromHistory(turns, null)).toBeNull();
  });

  it('1 つも無ければ null（上限が分かっていても）', () => {
    expect(contextFromHistory([], 1000)).toBeNull();
    expect(contextFromHistory([user(1), model(2, undefined)], 1000)).toBeNull();
  });

  it('recent は新しい順で最大 10', () => {
    const turns = Array.from({ length: 14 }, (_v, i) =>
      model(i + 1, { input: i + 1, cached: 0, cacheWrite: 0, output: 0 }),
    );
    const c = contextFromHistory(turns, null)!;
    expect(c.recent).toHaveLength(CONTEXT_RECENT_MAX);
    expect(c.recent.map((r) => r.tokens)).toEqual([14, 13, 12, 11, 10, 9, 8, 7, 6, 5]);
    expect(c.tokens).toBe(14);
  });

  it('model 名が無ければ null', () => {
    expect(contextFromHistory([model(1, { input: 1 })], null)?.model).toBeNull();
  });
});

describe('chat.status', () => {
  it('ターン数と最後の時刻を履歴から、残りはそのまま', () => {
    const s = buildChatStatus({
      engine: { running: false, busy: true, outstandingTools: 2 },
      turns: [
        { id: 'a', timestamp: 1, role: 'user', content: 'x', meta: {} },
        { id: 'b', timestamp: 9, role: 'model', content: 'y', meta: {} },
      ],
      session: { id: 's', title: '', createdAt: 0 },
      contextLimit: null,
    });
    expect(s).toEqual({
      running: false,
      busy: true,
      outstandingTools: 2,
      turns: 2,
      lastTurnAt: 9,
      session: { id: 's', title: '', createdAt: 0 },
      context: null,
    });
    expect(
      buildChatStatus({
        engine: { running: false, busy: false, outstandingTools: 0 },
        turns: [],
        session: null,
        contextLimit: null,
      }).lastTurnAt,
    ).toBeNull();
  });

  it('context は履歴から（上限は渡された値）', () => {
    const s = buildChatStatus({
      engine: { running: false, busy: false, outstandingTools: 0 },
      turns: [
        { id: 'a', timestamp: 1, role: 'user', content: 'x', meta: {} },
        {
          id: 'b',
          timestamp: 9,
          role: 'model',
          content: 'y',
          meta: { usage: { input: 1000, cached: 500, cacheWrite: 0, output: 4, total: 1504 }, model: 'm' },
        },
      ],
      session: null,
      contextLimit: 200000,
    });
    expect(s.context).toEqual({
      tokens: 1500,
      output: 4,
      model: 'm',
      at: '1970-01-01T00:00:00.009Z',
      limit: 200000,
      recent: [{ at: '1970-01-01T00:00:00.009Z', tokens: 1500, output: 4 }],
    });
    expect(formatChatStatus(s, 9)).toContain('context: 1,500 / 200,000 tokens in (m, 1970-01-01T00:00:00.009Z)');
    expect(formatChatStatus({ ...s, context: { ...s.context!, limit: null } }, 9)).toContain(
      'context: 1,500 tokens in (m, 1970-01-01T00:00:00.009Z)',
    );
    expect(formatChatStatus({ ...s, context: null }, 9)).toContain('context: unknown (no reply yet)');
  });
});
