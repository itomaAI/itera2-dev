/**
 * MetaOS.chat の規則（T-0634）。ホストの実体に触らない純関数の試験。
 */
import { describe, it, expect } from 'vitest';
import { buildAppendPlan, buildResetPlan, latestContextUsage, buildChatStatus, mimeOfAttachment } from './chatApi';

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

  it('添付は ai:ask と同じ並び（media 全部 → 注記 全部 → 本文）', () => {
    const p = buildAppendPlan({ role: 'user', content: 'see', opts: { attachments: ['a/b.png', 'c.txt'] } }, 'x');
    if (!p.ok) throw new Error(p.reason);
    expect(p.content).toEqual([
      { media: { path: 'a/b.png', mimeType: 'image/png', metadata: {} } },
      { media: { path: 'c.txt', mimeType: 'application/octet-stream', metadata: {} } },
      { text: '<user_attachment path="a/b.png">[Attachment]</user_attachment>' },
      { text: '<user_attachment path="c.txt">[Attachment]</user_attachment>' },
      { text: 'see' },
    ]);
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
      { media: { path: 'p.jpg', mimeType: 'image/png', metadata: {} } },
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

  it('MIME は従来の判定（画像の拡張子は image/png）', () => {
    expect(mimeOfAttachment('x.webp')).toBe('image/png');
    expect(mimeOfAttachment('x.pdf')).toBe('application/octet-stream');
  });
});

describe('chat.reset の計画', () => {
  it('既定は 起こす・道具を積み直す。summary の頭に呼び手と起動手順の促し', () => {
    const p = buildResetPlan(undefined, 'telegram_daemon');
    expect(p.wake).toBe(true);
    expect(p.restoreTools).toBe(true);
    expect(p.summary).toBe('[System: Session reset by telegram_daemon]\nPlease run the Initialization Protocol first.');
  });
  it('申し送りは Carried Over Information として続く。wake / restoreTools は false にできる', () => {
    const p = buildResetPlan({ summary: '  T-0633 を見張る  ', wake: false, restoreTools: false }, 'x');
    expect(p.summary.endsWith('\n\n[Carried Over Information]\nT-0633 を見張る')).toBe(true);
    expect(p.wake).toBe(false);
    expect(p.restoreTools).toBe(false);
  });
});

describe('直近の文脈の長さ（usage ログ）', () => {
  const line = (o: any) => JSON.stringify(o);
  it('末尾から tokens を持つ行を読み、長さは input＋cached＋cacheWrite', () => {
    const jsonl = [
      line({ timestamp: 't1', model: 'm', tokens: { input: 10, cached: 5, cacheWrite: 1, output: 3, total: 19 } }),
      'broken {',
      line({ timestamp: 't2', model: 'm', tokens: { input: 100, cached: 50, cacheWrite: 0, output: 7, total: 157 } }),
      line({ timestamp: 't3', other: true }),
      '',
    ].join('\n');
    expect(latestContextUsage(jsonl)).toEqual({ tokens: 150, output: 7, model: 'm', at: 't2' });
  });
  it('読める行が無ければ null', () => {
    expect(latestContextUsage('')).toBeNull();
    expect(latestContextUsage('{"a":1}\n')).toBeNull();
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
      context: null,
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
        context: null,
      }).lastTurnAt,
    ).toBeNull();
  });
});
