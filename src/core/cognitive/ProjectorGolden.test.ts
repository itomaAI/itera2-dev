/**
 * src/core/cognitive/ProjectorGolden.test.ts
 * 各社へ送る本文の金型（T-0804）。
 *
 * 投影を「履歴 → 中立」「中立 → 各社」に割る前のコードが作った本文を、snapshot に固定してある。
 * 割ったあとも同じ本文・同じ上げ方（fetch の順）・同じ控え（添付の metadata）になることを、この金型で見る。
 *
 * 🔴 金型（`__snapshots__/ProjectorGolden.test.ts.snap`）を書き換えるのは、各社へ送る本文を意図して変えるときだけ。
 *    作りを変えただけで金型が動いたら、それは作りの側の誤り。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AnthropicProjector, GeminiProjector, OpenAIProjector } from './Projector';
import type { RelayTransport } from './adapters/BaseAdapter';

const RELAY = 'https://relay.example/llmProxy';
const SYSTEM_PROMPT = 'SYS agent={{agentName}} user={{username}} lang={{language}}';
const T0 = Date.UTC(2026, 0, 2, 3, 4, 5);
const MB = 1024 * 1024;

type Kind = 'gemini-key' | 'gemini-nokey' | 'gemini-relay' | 'openai' | 'anthropic' | 'anthropic-relay';
const KINDS: Kind[] = ['gemini-key', 'gemini-nokey', 'gemini-relay', 'openai', 'anthropic', 'anthropic-relay'];

function relay(): RelayTransport {
  return { baseUrl: RELAY, getAuthHeaders: async () => ({ Authorization: 'Bearer T' }) };
}

/** 履歴から各社の本文までを通す入口。作りを変えたら、変えるのはここだけ（金型は変えない） */
function makeProjector(kind: Kind): { createContext(state: any, signal?: AbortSignal): Promise<any> } {
  const projector = (() => {
    switch (kind) {
      case 'gemini-key':
        return new GeminiProjector(SYSTEM_PROMPT, undefined, 'KEY');
      case 'gemini-nokey':
        return new GeminiProjector(SYSTEM_PROMPT, undefined, '');
      case 'gemini-relay':
        return new GeminiProjector(SYSTEM_PROMPT, undefined, '', relay());
      case 'openai':
        return new OpenAIProjector(SYSTEM_PROMPT, undefined);
      case 'anthropic':
        return new AnthropicProjector(SYSTEM_PROMPT, undefined);
      case 'anthropic-relay':
        return new AnthropicProjector(SYSTEM_PROMPT, undefined, relay());
    }
  })();
  // base64 は中身が読める形に（どのファイルが載ったかを金型で見分ける）
  (projector as any)._blobToBase64 = async (blob: Blob) => `B64(${await blob.text()})`;
  return projector;
}

// ---- 代役 -------------------------------------------------------------------

const SIZES: Record<string, number> = {
  'data/big.png': 600 * MB, // どの上流の上限も超える
  'data/mid.pdf': 30 * MB, // Anthropic の文書（24MB）だけ超える
  'data/mid.png': 4 * MB, // Anthropic の画像（3.75MB）だけ超える
};
const MISSING = 'data/gone.png';

function fakeVfs() {
  return {
    exists: (_p: unknown, path: string) => path !== MISSING,
    stat: (_p: unknown, path: string) => {
      if (path === MISSING) throw new Error('not found');
      return { size: SIZES[path] ?? 1024 };
    },
    readBlob: async (_p: unknown, path: string) =>
      new Blob([`bytes of ${path}`], { type: path.endsWith('.txt') ? 'text/plain' : 'application/octet-stream' }),
  } as any;
}

const media = (path: string, mimeType: string) => ({ path, mimeType }) as any;

let seq = 0;
function turn(role: string, content: any, meta: Record<string, unknown> = {}) {
  seq += 1;
  return { id: `t${seq}`, timestamp: T0 + seq * 1000, role, content, meta };
}

function toolEntry(actionType: string, params: Record<string, unknown>, output: Record<string, unknown>) {
  return { actionType, params, output };
}

/** ひととおりの形を持つ履歴 */
function fullHistory() {
  seq = 0;
  return [
    turn('model', 'モデルが先頭に居る履歴'),
    turn('user', 'こんにちは'),
    turn('system', '<event type="info">\n起動しました\n</event>', { type: 'event_log' }),
    turn('model', '<report>はい</report>\n<yield />'),
    turn('model', ''),
    turn('model', '   \n'),
    turn('user', [
      { text: 'これを見てください' },
      { text: '二行目' },
      { text: '<user_attachment name="a.txt">中身</user_attachment>' },
      { media: media('system/temp/media/shot.png', 'image/png') },
      { text: 'あとの文' },
      { media: media('data/doc.pdf', 'application/pdf') },
      { media: media('data/note.txt', 'text/plain') },
      { media: media('data/a.zip', 'application/zip') },
      { media: media('data/big.png', 'image/png') },
      { media: media('data/mid.pdf', 'application/pdf') },
      { media: media('data/mid.png', 'image/png') },
      { media: media(MISSING, 'image/png') },
    ]),
    turn('model', [{ text: '配列の model ターン' }, { text: '' }]),
    turn(
      'system',
      [
        toolEntry('read', { path: 'a.md' }, { log: 'Lines 1-2\nabc' }),
        toolEntry('take_screenshot', {}, { log: 'captured', media: media('system/temp/media/tool.png', 'image/png') }),
        toolEntry('noop', {}, { ui: '出さない' }),
        toolEntry('search', { query: 'say "hi"' }, { log: 'boom', error: true }),
        toolEntry('attach_file', { path: MISSING }, { media: media(MISSING, 'image/png') }),
      ],
      { type: 'tool_execution' },
    ),
    turn('system', [{ text: '<event type="app_event">\n通知\n</event>' }], { type: 'event_log' }),
    turn('user', '続けて'),
    turn('user', '同じ役割が続く'),
  ];
}

/** 期限内の控えを持つ添付（上げ直さない） */
function cachedHistory() {
  seq = 0;
  return [
    turn('user', [
      { text: '控えのある添付' },
      {
        media: {
          ...media('data/cached.png', 'image/png'),
          metadata: {
            gemini: { fileUri: 'files/own-cached', expirationTime: '2099-01-01T00:00:00Z', name: 'files/own-cached' },
            relay: {
              gemini: { fileUri: 'files/relay-cached', expirationTime: '2099-01-01T00:00:00Z', name: 'x' },
              anthropic: { fileId: 'file_cached' },
            },
          },
        },
      },
    ]),
  ];
}

function stateOf(turns: any[]) {
  return {
    history: { get: () => turns },
    vfs: fakeVfs(),
    configManager: {
      get: (category: string) =>
        category === 'preferences' ? { username: '山内', agentName: 'Itera', language: 'Japanese' } : undefined,
    },
  } as any;
}

const response = (body: any, headers: Record<string, string> = {}, status = 200) =>
  ({
    ok: status < 400,
    status,
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
    json: async () => body,
    text: async () => JSON.stringify(body),
  }) as any;

let fetchLog: string[];
let uploads: number;
let failUploads: boolean;

beforeEach(() => {
  // 履歴が空のとき、開始時刻は「いま」になる。時計を止めて金型に入る時刻を固定する（止めるのは Date だけ）
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
  fetchLog = [];
  uploads = 0;
  failUploads = false;
  globalThis.fetch = vi.fn(async (input: any, init: any = {}) => {
    const url = String(input);
    const shown = url.replace(/key=[^&]+/, 'key=…');
    fetchLog.push(`${init.method || 'GET'} ${shown}`);
    if (failUploads) return response({ error: 'nope' }, {}, 500);
    if (url.startsWith('https://generativelanguage.googleapis.com/upload/v1beta/files')) {
      uploads += 1;
      return response({}, { 'x-goog-upload-url': `https://upload.example/direct/${uploads}` });
    }
    if (url === `${RELAY}/google/upload/v1beta/files`) {
      uploads += 1;
      return response({}, { 'x-goog-upload-url': `https://upload.example/relay/${uploads}` });
    }
    if (url.startsWith('https://upload.example/')) {
      const name = `files/${url.slice('https://upload.example/'.length).replace('/', '-')}`;
      return response({ file: { uri: name, name, expirationTime: '2099-01-01T00:00:00Z' } });
    }
    if (url === `${RELAY}/anthropic/v1/files`) {
      uploads += 1;
      return response({ id: `file_${uploads}` });
    }
    return response({ error: `unexpected ${url}` }, {}, 404);
  }) as any;
});

afterEach(() => {
  vi.useRealTimers();
});

/** 履歴の中の添付に書かれた控え（投影が書き戻すもの） */
function mediaMetadata(turns: any[]): Record<string, unknown> {
  const found: Record<string, unknown> = {};
  let n = 0;
  for (const t of turns) {
    if (!Array.isArray(t.content)) continue;
    for (const node of t.content) {
      const m = node?.media ?? node?.output?.media;
      if (!m) continue;
      n += 1;
      found[`${n}:${m.path}`] = m.metadata ?? null;
    }
  }
  return found;
}

/** 端末の時刻帯と言語に依る 1 行だけ伏せる（開始時刻の表示。ISO の行は残す） */
function mask(json: string): string {
  return json.replace(
    /Session Started: .*?\((?:Sun|Mon|Tues|Wednes|Thurs|Fri|Satur)day\)/g,
    'Session Started: <local>',
  );
}

async function project(kind: Kind, turns: any[]) {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    const payload = await makeProjector(kind).createContext(stateOf(turns));
    return mask(JSON.stringify({ payload, fetch: fetchLog, media: mediaMetadata(turns) }, null, 2));
  } finally {
    warn.mockRestore();
    error.mockRestore();
  }
}

describe('各社へ送る本文の金型', () => {
  for (const kind of KINDS) {
    it(`${kind}: ひととおりの形を持つ履歴`, async () => {
      expect(await project(kind, fullHistory())).toMatchSnapshot();
    });

    it(`${kind}: 履歴が空（システムプロンプトだけ）`, async () => {
      expect(await project(kind, [])).toMatchSnapshot();
    });

    it(`${kind}: 控えのある添付は上げ直さない`, async () => {
      expect(await project(kind, cachedHistory())).toMatchSnapshot();
    });
  }

  for (const kind of ['gemini-key', 'gemini-relay', 'anthropic-relay'] as Kind[]) {
    it(`${kind}: 上げるのに失敗したとき`, async () => {
      failUploads = true;
      expect(await project(kind, fullHistory())).toMatchSnapshot();
    });
  }

  it('金型は時刻帯に依らない（伏せた 1 行のほかに端末の時刻が入っていない）', async () => {
    const out = await project('openai', fullHistory());
    expect(out).toContain('Session Started: <local>');
    expect(out).toContain('Timestamp: 2026-01-02T03:04:06.000Z');
  });
});
