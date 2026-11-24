/**
 * src/core/state/conversationEvents.test.ts
 * 会話の口が置く知らせの文（T-0908）。モデルが読む文なので、1 字ずつ固定する。
 */
import { describe, expect, it } from 'vitest';
import { sessionActivatedEvent, sessionResetEvent, toolsRestoredEvent } from './conversationEvents';

const DEF_A = '<toolset name="A" pid="a">\n  <define_tag name="x">X</define_tag>\n</toolset>';
const DEF_B = '<toolset name="B" pid="b">\n</toolset>';

describe('toolsRestoredEvent — 動的な道具の定義', () => {
  it('定義を改行でつないで置く。起こさない', () => {
    expect(toolsRestoredEvent([DEF_A, DEF_B])).toEqual({
      content:
        '<event type="tool_available">\n[System: Restored Dynamic Tools]\n' +
        'The following tools are currently active from background processes:\n' +
        `${DEF_A}\n${DEF_B}\n</event>`,
      meta: { type: 'tool_available', eventType: 'tool_available', trigger_llm: false },
    });
  });

  it('定義が無ければ、何も置かない', () => {
    expect(toolsRestoredEvent([])).toBeNull();
  });
});

describe('sessionResetEvent — 空にしたあとの申し送り', () => {
  it('申し送りを包む。起こすかどうかは渡されたとおり', () => {
    expect(sessionResetEvent('carry this', true)).toEqual({
      content: '<event type="session_reset">\n[Session Restored & Context Compressed]\n\ncarry this\n</event>',
      meta: { type: 'event_log', trigger_llm: true },
    });
    expect(sessionResetEvent('x', false).meta.trigger_llm).toBe(false);
  });
});

describe('sessionActivatedEvent — 前の会話に戻った・保存から読み込んだ印', () => {
  const LAST = Date.UTC(2026, 10, 24, 1, 2, 3);
  const NOW = Date.UTC(2026, 10, 24, 11, 0, 0);

  it('読み込み: 最後に動いた時刻といまの時刻を並べ、道具の定義を添える。起こさない', () => {
    expect(sessionActivatedEvent('loaded', LAST, NOW, [DEF_A])).toEqual({
      content:
        '<event type="session_loaded">\n' +
        '[System: Loaded a session from the VFS (last activity 2026-11-24T01:02:03.000Z). Time now: 2026-11-24T11:00:00.000Z.]\n' +
        'Files, processes and tool definitions may have changed since. Re-check before acting.\n' +
        'The following tools are currently active from background processes:\n' +
        `${DEF_A}\n</event>`,
      meta: { type: 'event_log', eventType: 'session_loaded', trigger_llm: false },
    });
  });

  it('切り替え: 文の頭と種類が変わる。定義が無ければ、その 2 行は置かない', () => {
    expect(sessionActivatedEvent('switched', LAST, NOW, [])).toEqual({
      content:
        '<event type="session_switched">\n' +
        '[System: Switched to an earlier session (last activity 2026-11-24T01:02:03.000Z). Time now: 2026-11-24T11:00:00.000Z.]\n' +
        'Files, processes and tool definitions may have changed since. Re-check before acting.\n' +
        '</event>',
      meta: { type: 'event_log', eventType: 'session_switched', trigger_llm: false },
    });
  });
});
