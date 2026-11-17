/**
 * tests/guest/localBridgeToken.test.ts
 * Local Bridge: 接続用トークンを送る側（デーモン・設定アプリ・ホーム）
 *
 * 対象はゲスト実装（`vfs_root/system/services/local_bridge.html`・`system/apps/local_bridge_settings.html`・
 * `system/apps/home.html`）。vitest の対象外なので、**実装をコピーせずソースから取り出して評価する**。
 * サーバーの側（検査・トークンのファイル・CLI）は `test_bridge_server_token.py`。
 *
 * ここで守るもの:
 *   1. トークンの無い接続では、要求が今までと変わらない（ヘッダを足さない＝preflight も増えない）。
 *   2. トークンのある接続では、サーバーへの道の全部に付く。道はデーモンの中に 1 つしか無い
 *      （付け忘れた 1 本だけが 401 になると、同期が半端に進む）。
 *   3. 401 を「サーバーが止まっている」と混ぜない（要る／通らない を分けて持つ）。
 *   4. 保存済みのトークンを画面に出さない。
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const read = (rel: string) => readFileSync(resolve(__dirname, '../..', rel), 'utf-8');
const DAEMON = read('vfs_root/system/services/local_bridge.html');
const SETTINGS = read('vfs_root/system/apps/local_bridge_settings.html');
const HOME = read('vfs_root/system/apps/home.html');

/** ソースから断片を切り出す。取り出せなければ**失敗させる**（黙って素通りさせない）。 */
function extract(src: string, re: RegExp, label: string): string {
  const m = src.match(re);
  if (!m) {
    throw new Error(
      `${label} を取り出せなかった。実装の書き方が変わった可能性がある。試験を通す前に、まず対象を確認すること。`,
    );
  }
  return m[0];
}

type Call = { url: string; opts: any };
const response = (status: number, body: any = {}) => ({
  status,
  ok: status >= 200 && status < 300,
  json: async () => body,
  text: async () => JSON.stringify(body),
});

// ---------------------------------------------------------------------------
// デーモン
// ---------------------------------------------------------------------------

function loadGate(statuses: number[]) {
  const src = [
    extract(DAEMON, /function bridgeFetch\(conn, path, opts\) \{[\s\S]*?\n {8}\}/, 'bridgeFetch'),
    extract(DAEMON, /function noteAuth\(conn, httpStatus\) \{[\s\S]*?\n {8}\}/, 'noteAuth'),
    extract(DAEMON, /function authMessage\(conn\) \{[\s\S]*?\n {8}\}/, 'authMessage'),
    extract(DAEMON, /async function getJson\(conn, path, opts\) \{[\s\S]*?\n {8}\}/, 'getJson'),
  ].join('\n');
  const calls: Call[] = [];
  const logs: string[] = [];
  const queue = [...statuses];
  const fetch = async (url: string, opts: any) => {
    calls.push({ url, opts });
    return response(queue.length ? (queue.shift() as number) : 200, { ok: true });
  };
  const log = (msg: string) => logs.push(msg);
  const mod = new Function('fetch', 'log', `${src}\nreturn { bridgeFetch, getJson };`)(fetch, log);
  return { ...mod, calls, logs } as {
    bridgeFetch: (conn: any, path: string, opts?: any) => Promise<any>;
    getJson: (conn: any, path: string, opts?: any) => Promise<any>;
    calls: Call[];
    logs: string[];
  };
}

const conn = (token = '') => ({ name: 'yachiyo', serverUrl: 'http://127.0.0.1:8001', token, auth: null as any });

describe('デーモン: サーバーへの道', () => {
  it('トークンの無い接続では、要求に何も足さない', async () => {
    const g = loadGate([200, 200]);
    const opts = { method: 'PUT', body: 'x', headers: { 'X-Expected-Hash': 'h' } };
    await g.bridgeFetch(conn(), '/api/ws/file/a.txt', opts);
    await g.bridgeFetch(conn(), '/api/status');
    expect(g.calls[0].url).toBe('http://127.0.0.1:8001/api/ws/file/a.txt');
    expect(g.calls[0].opts).toEqual({ method: 'PUT', body: 'x', headers: { 'X-Expected-Hash': 'h' } });
    // ヘッダの鍵そのものを作らない（Authorization が付くと、ブラウザは GET にも preflight を出す）
    expect(g.calls[1].opts).toEqual({});
  });

  it('トークンのある接続では Authorization を付け、呼び手のヘッダを残す', async () => {
    const g = loadGate([200, 200]);
    const opts = { method: 'DELETE', headers: { 'X-Expected-Hash': 'h' } };
    await g.bridgeFetch(conn('s3cret'), '/api/ws/file/a.txt', opts);
    await g.bridgeFetch(conn('s3cret'), '/api/status');
    expect(g.calls[0].opts).toEqual({
      method: 'DELETE',
      headers: { 'X-Expected-Hash': 'h', Authorization: 'Bearer s3cret' },
    });
    expect(g.calls[1].opts).toEqual({ headers: { Authorization: 'Bearer s3cret' } });
    // 呼び手の持ち物を書き換えない
    expect(opts).toEqual({ method: 'DELETE', headers: { 'X-Expected-Hash': 'h' } });
  });

  it('getJson も同じ道を通る', async () => {
    const g = loadGate([200]);
    await g.getJson(conn('s3cret'), '/api/ws/meta');
    expect(g.calls[0].url).toBe('http://127.0.0.1:8001/api/ws/meta');
    expect(g.calls[0].opts.headers.Authorization).toBe('Bearer s3cret');
  });

  it('素の fetch は道の中の 1 か所だけ（ほかの場所からサーバーを叩かない）', () => {
    const raw = DAEMON.match(/(?<![A-Za-z_.])fetch\(/g) || [];
    expect(raw.length).toBe(1);
    expect(DAEMON).toMatch(/return fetch\(`\$\{conn\.serverUrl\}\$\{path\}`, o\)/);
    expect(DAEMON.includes('api(conn')).toBe(false);
  });

  it('設定のトークンは前後の空白を落として持つ。無い・文字列でないものは空', () => {
    const src = extract(
      DAEMON,
      /const connections = \(config\.connections \|\| \[\]\)[\s\S]*?\n {10}\}\)\);/,
      '接続の実行時表現',
    );
    const config = {
      connections: [
        { serverUrl: 'http://a:1/', token: '  tok\n' },
        { serverUrl: 'http://b:2' },
        { serverUrl: 'http://c:3', token: 123 },
      ],
    };
    const conns = new Function('config', `${src}\nreturn connections;`)(config);
    expect(conns.map((c: any) => c.token)).toEqual(['tok', '', '']);
    expect(conns.map((c: any) => c.auth)).toEqual([null, null, null]);
  });
});

describe('デーモン: 401 の扱い', () => {
  it('トークンを持たずに断られたら required、持っていて断られたら rejected', async () => {
    const g = loadGate([401, 401]);
    const a = conn();
    const b = conn('wrong');
    await g.bridgeFetch(a, '/api/status');
    await g.bridgeFetch(b, '/api/status');
    expect(a.auth).toBe('required');
    expect(b.auth).toBe('rejected');
    expect(g.logs[0]).toMatch(/requires a token/);
    expect(g.logs[1]).toMatch(/did not accept the token/);
  });

  it('ログは状態が変わったときに 1 度だけ', async () => {
    const g = loadGate([401, 401, 401, 200, 200]);
    const c = conn('wrong');
    for (let i = 0; i < 5; i++) await g.bridgeFetch(c, '/api/status');
    expect(c.auth).toBe(null);
    expect(g.logs.length).toBe(2); // 断られた・通った
    expect(g.logs[1]).toMatch(/accepted/);
  });

  it('401 でない応答は、関門を通っている（404・409・500 で断られた扱いにしない）', async () => {
    for (const status of [404, 409, 500]) {
      const g = loadGate([401, status]);
      const c = conn('tok');
      await g.bridgeFetch(c, '/api/status');
      expect(c.auth).toBe('rejected');
      await g.bridgeFetch(c, '/api/ws/file/a.txt');
      expect(c.auth).toBe(null);
    }
  });

  it('getJson は 401 を、止まっているのとは別の文で投げる', async () => {
    const g = loadGate([401, 500]);
    const c = conn();
    await expect(g.getJson(c, '/api/exec', { method: 'POST' })).rejects.toMatchObject({
      status: 401,
      message: expect.stringMatching(/yachiyo: the server requires a token/),
    });
    await expect(g.getJson(c, '/api/exec', { method: 'POST' })).rejects.toMatchObject({
      status: 500,
      message: expect.stringMatching(/^HTTP 500/),
    });
  });

  it('断られている間は、切断のときより長い間隔で見直す', () => {
    const retry = Number(extract(DAEMON, /const AUTH_RETRY_MS = (\d+);/, 'AUTH_RETRY_MS').match(/(\d+)/)![1]);
    const poll = Number(extract(DAEMON, /const ROOT_POLL_MS = (\d+);/, 'ROOT_POLL_MS').match(/(\d+)/)![1]);
    expect(retry).toBeGreaterThanOrEqual(poll * 6);
    expect(DAEMON).toMatch(/const idle = conn\.auth \? AUTH_RETRY_MS : ROOT_POLL_MS;/);
    expect(DAEMON).toMatch(/const gap = status && conn\.longPoll \? MIN_LOOP_MS - spent : idle;/);
  });
});

// ---------------------------------------------------------------------------
// 設定アプリ
// ---------------------------------------------------------------------------

function loadProbe(status: number) {
  const src = extract(SETTINGS, /async function probe\(cfgConn\) \{[\s\S]*?\n {6}\}/, 'probe');
  const calls: Call[] = [];
  const fetch = async (url: string, opts: any) => {
    calls.push({ url, opts });
    return response(status, { version: '3.9.0', tokenRequired: true, roots: [] });
  };
  const probe = new Function('fetch', `${src}\nreturn probe;`)(fetch) as (c: any) => Promise<any>;
  return { probe, calls };
}

describe('設定アプリ: 接続の確かめ', () => {
  it('トークンの無い接続には何も付けない', async () => {
    const p = loadProbe(200);
    const out = await p.probe({ serverUrl: 'http://127.0.0.1:8001/' });
    expect(p.calls).toEqual([{ url: 'http://127.0.0.1:8001/api/status', opts: {} }]);
    expect(out.ok).toBe(true);
    expect(out.auth).toBe(null);
  });

  it('トークンのある接続には Authorization を付ける（空白は落とす）', async () => {
    const p = loadProbe(200);
    const out = await p.probe({ serverUrl: 'http://127.0.0.1:8001', token: ' tok ' });
    expect(p.calls[0].opts).toEqual({ headers: { Authorization: 'Bearer tok' } });
    expect(out.ok).toBe(true);
  });

  it('401 は「繋がらない」と分ける', async () => {
    const p = loadProbe(401);
    const need = await p.probe({ serverUrl: 'http://127.0.0.1:8001' });
    expect(need).toMatchObject({ ok: false, auth: 'required', status: null });
    const bad = await p.probe({ serverUrl: 'http://127.0.0.1:8001', token: 'wrong' });
    expect(bad).toMatchObject({ ok: false, auth: 'rejected', status: null });
  });

  it('ほかの失敗は auth を立てない', async () => {
    const p = loadProbe(500);
    const out = await p.probe({ serverUrl: 'http://127.0.0.1:8001', token: 'tok' });
    expect(out).toMatchObject({ ok: false, auth: null, error: 'HTTP 500' });
  });

  it('無効にした接続は叩かない', async () => {
    const p = loadProbe(200);
    const out = await p.probe({ serverUrl: 'http://127.0.0.1:8001', token: 'tok', enabled: false });
    expect(p.calls.length).toBe(0);
    expect(out.error).toBe('Disabled');
  });
});

function loadSaveToken(typed: string | null, cfg: any) {
  const src = extract(SETTINGS, /async function saveToken\(url\) \{[\s\S]*?\n {6}\}/, 'saveToken');
  const written: any[] = [];
  let hinted = 0;
  const input = typed === null ? null : { value: typed };
  const DOM = (id: string) => (id === 'token-input' ? input : null);
  const mutateConfig = async (fn: (c: any) => any) => {
    const next = fn(JSON.parse(JSON.stringify(cfg)));
    if (!next) return false;
    written.push(next);
    return true;
  };
  const notifyRestartNeeded = () => {
    hinted++;
  };
  const saveToken = new Function(
    'DOM',
    'mutateConfig',
    'notifyRestartNeeded',
    `let tokenEdit = { url: 'x', draft: 'y', focus: true };\n${src}\nreturn saveToken;`,
  )(DOM, mutateConfig, notifyRestartNeeded) as (url: string) => Promise<void>;
  return { saveToken, written, hinted: () => hinted, input };
}

describe('設定アプリ: トークンの保存', () => {
  const cfg = () => ({
    connections: [
      { serverUrl: 'http://127.0.0.1:8001/', name: 'yachiyo', execMode: 'auto' },
      { serverUrl: 'http://127.0.0.1:8003', name: 'kukuri', token: 'old' },
    ],
  });

  it('打った値を、その接続だけに書く（デーモンが読む鍵 `token`）', async () => {
    const h = loadSaveToken('  new-token \n', cfg());
    await h.saveToken('http://127.0.0.1:8001');
    expect(h.written.length).toBe(1);
    expect(h.written[0].connections[0]).toEqual({
      serverUrl: 'http://127.0.0.1:8001/',
      name: 'yachiyo',
      execMode: 'auto',
      token: 'new-token',
    });
    expect(h.written[0].connections[1].token).toBe('old');
    expect(h.hinted()).toBe(1);
    // 欄に打った値を残さない
    expect(h.input!.value).toBe('');
  });

  it('空で保存したら、鍵ごと外す', async () => {
    const h = loadSaveToken('   ', cfg());
    await h.saveToken('http://127.0.0.1:8003');
    expect('token' in h.written[0].connections[1]).toBe(false);
    expect(h.hinted()).toBe(1);
  });

  it('設定に無い接続には書かない', async () => {
    const h = loadSaveToken('tok', cfg());
    await h.saveToken('http://127.0.0.1:9999');
    expect(h.written.length).toBe(0);
    expect(h.hinted()).toBe(0);
  });
});

describe('設定アプリ: 保存済みのトークンを画面に出さない', () => {
  it('入力欄は値を持たずに描かれる（password）', () => {
    const src = extract(SETTINGS, /function tokenRow\(url\) \{[\s\S]*?\n {6}\}/, 'tokenRow');
    const esc = (s: string) => s;
    const html = new Function('esc', `${src}\nreturn tokenRow;`)(esc)('http://127.0.0.1:8001') as string;
    expect(html).toMatch(/id="token-input" type="password"/);
    expect(html).not.toMatch(/value=/);
  });

  it('描画のどこにも、トークンの値を差し込まない（在る・無いだけを使う）', () => {
    // `${c.cfg.token ? … : …}` は真偽だけ。値を文字列に入れる形（`${…token}`・esc(…token)）が無いこと
    expect(SETTINGS).not.toMatch(/esc\([^)]*token[^)]*\)/i);
    expect(SETTINGS).not.toMatch(/\$\{[^}?]*\.token\s*\}/);
    expect(SETTINGS).toMatch(/\$\{c\.cfg\.token \? 'Token ✓' : 'Token…'\}/);
  });
});

// ---------------------------------------------------------------------------
// ホーム
// ---------------------------------------------------------------------------

function loadHomeFetch(status: number) {
  const src = extract(HOME, /const fetchJson = async \(url, ms, token\) => \{[\s\S]*?\n {8}\};/, 'fetchJson');
  const calls: Call[] = [];
  const fetch = async (url: string, opts: any) => {
    calls.push({ url, opts });
    return response(status, { roots: [] });
  };
  const fetchJson = new Function('fetch', `${src}\nreturn fetchJson;`)(fetch) as (
    url: string,
    ms: number,
    token?: string,
  ) => Promise<any>;
  return { fetchJson, calls };
}

describe('ホーム: 接続の欄', () => {
  it('トークンの無い接続には何も付けない', async () => {
    const h = loadHomeFetch(200);
    await h.fetchJson('http://127.0.0.1:8001/api/status', 3000, '');
    expect(Object.keys(h.calls[0].opts)).toEqual(['signal']);
  });

  it('トークンのある接続には Authorization を付ける', async () => {
    const h = loadHomeFetch(200);
    await h.fetchJson('http://127.0.0.1:8001/api/status', 3000, 'tok');
    expect(h.calls[0].opts.headers).toEqual({ Authorization: 'Bearer tok' });
  });

  it('401 は status を持った失敗として投げる（offline と分けるため）', async () => {
    const h = loadHomeFetch(401);
    await expect(h.fetchJson('http://127.0.0.1:8001/api/status', 3000, '')).rejects.toMatchObject({ status: 401 });
  });

  it('設定のトークンを渡し、401 を offline と別の文にする', () => {
    expect(HOME).toMatch(/const token = typeof c\.token === 'string' \? c\.token\.trim\(\) : '';/);
    expect(HOME).toMatch(/fetchJson\(`\$\{c\.serverUrl\}\/api\/status`, 3000, token\)/);
    expect(HOME).toMatch(/e\.status === 401 \? \(token \? 'token rejected' : 'token required'\) : null/);
    expect(HOME).toMatch(/text = auth \|\| 'offline';/);
  });
});
