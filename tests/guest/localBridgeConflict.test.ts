/**
 * tests/guest/localBridgeConflict.test.ts
 * Local Bridge の衝突判定（T-0013）
 *
 * 対象は `vfs_root/system/services/local_bridge.html`（ゲスト実装）。
 * vitest の対象外なので、**実装をコピーせずソースから取り出して評価する**。
 *
 * 背景:
 *   3-way マージには分岐が7つしかなく、「両方が動いた」場合の分岐が無かった。
 *   どれにも該当しないまま素通りし、next は { ...anchor } なので古い値が残る。
 *   次の巡回でも同じ判定になり、**永久に、無言で**同期されなくなる。
 *   実際に、私の edit_file とデーモンの書き込みが同一ミリ秒で衝突して発生した。
 *
 * ここで守るのは「衝突を衝突と呼べること」である。
 * 分岐5・6・7で正しく処理される場合を衝突と誤判定すると、
 * 何も壊れていないファイルが毎回退避されて増殖する。
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SOURCE_PATH = resolve(__dirname, '../../vfs_root/system/services/local_bridge.html');

function loadIsConflict() {
  const src = readFileSync(SOURCE_PATH, 'utf-8');
  const m = src.match(/function isConflict\(l, r, a, same\) \{[\s\S]*?\n {8}\}/);
  if (!m) {
    throw new Error(
      'local_bridge.html から isConflict を取り出せなかった。実装の書き方が変わった可能性がある。' +
        '試験を通す前に、まず対象を確認すること。',
    );
  }
  const factory = new Function(`${m[0]}\nreturn isConflict;`);
  return factory() as (l: any, r: any, a: any, same: (x: any, y: any) => boolean) => boolean;
}

/** 実装と同じ比較（ハッシュのみを見る） */
const same = (x: any, y: any) => (x?.hash || null) === (y?.hash || null);

const F = (hash: string | null) => ({ kind: 'file', hash });

describe('local_bridge: 衝突（両側が動いた）の判定', () => {
  it('両側がアンカーから別々に動いていたら衝突（本命）', () => {
    const isConflict = loadIsConflict();
    expect(isConflict(F('L'), F('R'), F('A'), same)).toBe(true);
  });

  it('ローカルだけ動いたものは衝突ではない（分岐5が処理する）', () => {
    const isConflict = loadIsConflict();
    expect(isConflict(F('L'), F('A'), F('A'), same)).toBe(false);
  });

  it('リモートだけ動いたものは衝突ではない（分岐6が処理する）', () => {
    const isConflict = loadIsConflict();
    expect(isConflict(F('A'), F('R'), F('A'), same)).toBe(false);
  });

  it('内容が一致していれば衝突ではない（分岐7が吸収する）', () => {
    const isConflict = loadIsConflict();
    // 両側がアンカーから動いているが、結果が同じ。
    // ここを衝突にすると、収束して直った項目まで毎回退避されてしまう。
    // （実際、止まっていた項目はこの経路で復旧させた）
    expect(isConflict(F('X'), F('X'), F('A'), same)).toBe(false);
  });

  it('片側が存在しないものは衝突ではない（新規・削除は分岐2〜4）', () => {
    const isConflict = loadIsConflict();
    expect(isConflict(null, F('R'), F('A'), same)).toBe(false);
    expect(isConflict(F('L'), null, F('A'), same)).toBe(false);
    expect(isConflict(null, null, F('A'), same)).toBe(false);
  });

  it('アンカーが無い状態で両側に別内容があるなら衝突として扱う', () => {
    const isConflict = loadIsConflict();
    // アンカーを消しても分岐5・6・7は成立しないため、
    // ここを false にすると、やはり永久に素通りする項目が残る。
    expect(isConflict(F('L'), F('R'), undefined, same)).toBe(true);
  });

  it('アンカーが無く、両側の内容が同じなら衝突ではない', () => {
    const isConflict = loadIsConflict();
    expect(isConflict(F('X'), F('X'), undefined, same)).toBe(false);
  });
});

/**
 * local_fetch の1件ごとの判断（T-0013 の派生）
 *
 * 以前の実装は「実体化済みなら何もしない」で成功を返していた。
 * それは『VFS に実体があるか』の報告であって『ホストと一致しているか』の報告ではない。
 * 中身が食い違っていても「既に実体」と答えるため、修復に使えないばかりか
 * 「確認した」という誤った安心を与えていた。
 */
function loadClassifyFetchTarget() {
  const src = readFileSync(SOURCE_PATH, 'utf-8');
  const isStub = src.match(/const isStub = \(info\) => [^;]+;/);
  const fn = src.match(/function classifyFetchTarget\(info, r\) \{[\s\S]*?\n {8}\}/);
  if (!isStub || !fn) {
    throw new Error(
      'local_bridge.html から classifyFetchTarget / isStub を取り出せなかった。' +
        '実装の書き方が変わった可能性がある。試験を通す前に、まず対象を確認すること。',
    );
  }
  const factory = new Function(`${isStub[0]}\n${fn[0]}\nreturn classifyFetchTarget;`);
  return factory() as (info: any, r: any) => string;
}

describe('local_fetch: 1件ごとの扱いを決める', () => {
  it('スタブは落としてくる', () => {
    const classify = loadClassifyFetchTarget();
    expect(classify({ syncState: 'stub', hash: 'H' }, { hash: 'H' })).toBe('stub');
  });

  it('実体があり、ホストと一致していれば何もしない', () => {
    const classify = loadClassifyFetchTarget();
    expect(classify({ hash: 'H' }, { hash: 'H' })).toBe('match');
  });

  it('実体があり、ホストと違えば衝突として扱う（本命 / 以前は「既に実体」と嘘をついていた）', () => {
    const classify = loadClassifyFetchTarget();
    expect(classify({ hash: 'LOCAL' }, { hash: 'HOST' })).toBe('conflict');
  });

  it('ホストに無いものは衝突ではない（消さずに報告するだけ）', () => {
    const classify = loadClassifyFetchTarget();
    expect(classify({ hash: 'LOCAL' }, undefined)).toBe('gone');
    expect(classify({ hash: 'LOCAL' }, { isDeleted: true })).toBe('gone');
  });

  it('スタブ判定は syncState で行う（hash の有無では判定できない）', () => {
    const classify = loadClassifyFetchTarget();
    // createStub にホスト側のハッシュを渡しているため、スタブでも hash は非 null。
    // hash で判定すると、スタブが「実体あり」に見えて実体化されなくなる（過去に踏んだ）。
    expect(classify({ syncState: 'stub', hash: 'H' }, { hash: 'OTHER' })).toBe('stub');
  });
});

/**
 * 「利用者が VFS 側で消した」の判定と、衝突の退避が生き残ること（T-0069 / 2026-08-22）
 *
 * 何が起きたか:
 *   衝突のたびにデーモンは VFS 側の内容をホストへ `<名前>.conflict-<時刻>` として退避し、
 *   「どちらも失われていません」と通知していた。**退避ファイルは実在しなかった。**
 *   0.1 秒刻みで観測したところ、退避は作られた **1.97 秒後**に消えていた。
 *   消していたのはデーモン自身である（サーバーの DELETE を通っており墓石が残っていた）。
 *
 * 機序:
 *   resolveConflict は退避を next（＝次のアンカー）にだけ書き、VFS 側に節点を作らなかった。
 *   次の巡回で「アンカーにある・リモートにある・VFS に無い」となり、
 *   分岐2（isLocallyDeleted）が「利用者が消した」と読んでホスト側を消した。
 *
 * ここで守るのは二点:
 *   1. **アンカーに載せた項目には、必ず VFS 側の節点がある**（不変条件）。
 *   2. 退避に失敗したときは**何も触らずに保留**し、成功したとは言わない。
 *
 * 番人が「守った」と報告して実際には守っていないのは、番人が無いことより悪い。
 */

function loadIsLocallyDeleted() {
  const src = readFileSync(SOURCE_PATH, 'utf-8');
  const m = src.match(/function isLocallyDeleted\(l, r, a, same\) \{[\s\S]*?\n {8}\}/);
  if (!m) {
    throw new Error(
      'local_bridge.html から isLocallyDeleted を取り出せなかった。実装の書き方が変わった可能性がある。' +
        '試験を通す前に、まず対象を確認すること。',
    );
  }
  const factory = new Function(`${m[0]}\nreturn isLocallyDeleted;`);
  return factory() as (l: any, r: any, a: any, same: (x: any, y: any) => boolean) => boolean;
}

describe('local_bridge: ホストの実体を消してよいかの判定（分岐2）', () => {
  it('VFS から消えていて、リモートとアンカーが一致していれば「利用者が消した」（本命）', () => {
    const isLocallyDeleted = loadIsLocallyDeleted();
    expect(isLocallyDeleted(undefined, F('A'), F('A'), same)).toBe(true);
  });

  it('VFS に節点があれば消さない', () => {
    const isLocallyDeleted = loadIsLocallyDeleted();
    expect(isLocallyDeleted(F('A'), F('A'), F('A'), same)).toBe(false);
  });

  it('リモート側が動いていれば消さない（未確認の変更を消してはならない）', () => {
    const isLocallyDeleted = loadIsLocallyDeleted();
    expect(isLocallyDeleted(undefined, F('R'), F('A'), same)).toBe(false);
  });

  it('アンカーに無いものは消さない（リモートの新規。分岐3が拾う）', () => {
    const isLocallyDeleted = loadIsLocallyDeleted();
    expect(isLocallyDeleted(undefined, F('R'), undefined, same)).toBe(false);
  });

  it('★ アンカーにだけ載っていて VFS に節点が無い項目は「消された」に見える（T-0069 の機序そのもの）', () => {
    const isLocallyDeleted = loadIsLocallyDeleted();
    // 退避ファイルは、まさにこの形でアンカーへ入っていた。
    // だから「アンカーに載せるなら節点を作る」が不変条件になる。
    expect(isLocallyDeleted(undefined, F('BACKUP'), F('BACKUP'), same)).toBe(true);
  });
});

interface ConflictHarness {
  resolveConflict: (mount: any, rel: string, full: string, r: any, next: any) => Promise<boolean>;
  puts: { url: string; size: number }[];
  stubs: Record<string, any>;
  notices: string[];
}

/** resolveConflict を実装から取り出し、偽のホスト・偽の VFS で走らせる。 */
function loadResolveConflict(opts: { putFails?: boolean; backupStubFails?: boolean } = {}): ConflictHarness {
  const src = readFileSync(SOURCE_PATH, 'utf-8');
  const m = src.match(/async function resolveConflict\(mount, rel, full, r, next\) \{[\s\S]*?\n {8}\}/);
  if (!m) {
    throw new Error(
      'local_bridge.html から resolveConflict を取り出せなかった。実装の書き方が変わった可能性がある。' +
        '試験を通す前に、まず対象を確認すること。',
    );
  }

  const puts: { url: string; size: number }[] = [];
  const stubs: Record<string, any> = {};
  const notices: string[] = [];

  const MetaOS = {
    fs: {
      read: async () => new Uint8Array([1, 2, 3]),
      createStub: async (path: string, meta: any) => {
        if (opts.backupStubFails && path.includes('.conflict-')) {
          throw new Error('VFS が節点を作れなかった');
        }
        stubs[path] = meta;
      },
    },
    host: { notify: (msg: string) => notices.push(msg) },
    ai: { log: (msg: string) => notices.push(msg) },
  };
  const getJson = async (url: string, o: any) => {
    puts.push({ url, size: o.body.length });
    if (opts.putFails) throw new Error('HTTP 500 ホストが受け取らなかった');
    return { size: 3, updatedAt: 111, hash: 'BACKUP' };
  };
  const api = (conn: any, path: string) => `${conn.serverUrl}${path}`;
  const log = (msg: string) => notices.push(msg);
  const conflictNotified = new Set<string>();

  const factory = new Function(
    'MetaOS',
    'getJson',
    'api',
    'log',
    'conflictNotified',
    `${m[0]}\nreturn resolveConflict;`,
  );
  return {
    resolveConflict: factory(MetaOS, getJson, api, log, conflictNotified),
    puts,
    stubs,
    notices,
  };
}

const MOUNT = {
  conn: { name: 'spark', serverUrl: 'http://host' },
  root: 'workspace',
  mountPath: 'local/spark/workspace',
};
const REL = 'a/b.txt';
const FULL = `${MOUNT.mountPath}/${REL}`;
const REMOTE = { kind: 'file', size: 9, updatedAt: 222, hash: 'HOST' };

describe('local_bridge: 衝突の退避が生き残ること（T-0069）', () => {
  it('VFS 側の内容をホストへ退避する', async () => {
    const h = loadResolveConflict();
    const ok = await h.resolveConflict(MOUNT, REL, FULL, REMOTE, {});
    expect(ok).toBe(true);
    expect(h.puts).toHaveLength(1);
    expect(h.puts[0].url).toMatch(/\/api\/workspace\/file\/a\/b\.txt\.conflict-/);
  });

  it('★ 退避ファイルには VFS 側の節点も作る（作らないと次の巡回で消される）', async () => {
    const h = loadResolveConflict();
    const next: any = {};
    await h.resolveConflict(MOUNT, REL, FULL, REMOTE, next);
    const backupRel = Object.keys(next).find((k) => k.includes('.conflict-'));
    expect(backupRel).toBeDefined();
    expect(h.stubs[`${MOUNT.mountPath}/${backupRel}`]).toBeDefined();
  });

  it('★ 不変条件: アンカーへ足した項目は、すべて VFS 側に節点がある', async () => {
    const h = loadResolveConflict();
    const next: any = {};
    await h.resolveConflict(MOUNT, REL, FULL, REMOTE, next);
    for (const rel of Object.keys(next)) {
      expect(h.stubs[`${MOUNT.mountPath}/${rel}`], `${rel} の節点が無い`).toBeDefined();
    }
  });

  it('★ その結果、次の巡回で退避が「利用者が消した」と読まれない', async () => {
    const h = loadResolveConflict();
    const next: any = {};
    await h.resolveConflict(MOUNT, REL, FULL, REMOTE, next);
    const backupRel = Object.keys(next).find((k) => k.includes('.conflict-'))!;
    const isLocallyDeleted = loadIsLocallyDeleted();

    const l = h.stubs[`${MOUNT.mountPath}/${backupRel}`]; // VFS の節点
    const r = { hash: 'BACKUP' }; // ホストの退避
    const a = next[backupRel]; // アンカー
    expect(isLocallyDeleted(l, r, a, same)).toBe(false);
  });

  it('VFS に節点を作れなかったときは、アンカーにも載せない（載せない側へ倒す）', async () => {
    const h = loadResolveConflict({ backupStubFails: true });
    const next: any = {};
    const ok = await h.resolveConflict(MOUNT, REL, FULL, REMOTE, next);
    expect(ok).toBe(true); // 元のパスの同期は進めてよい
    expect(Object.keys(next).some((k) => k.includes('.conflict-'))).toBe(false);
    // 載せていないので、次の巡回では「リモートに新規」として拾われる
    const isLocallyDeleted = loadIsLocallyDeleted();
    expect(isLocallyDeleted(undefined, { hash: 'BACKUP' }, undefined, same)).toBe(false);
  });

  it('退避の PUT が失敗したら、何も触らずに保留する（fail-closed）', async () => {
    const h = loadResolveConflict({ putFails: true });
    const next: any = {};
    const ok = await h.resolveConflict(MOUNT, REL, FULL, REMOTE, next);
    expect(ok).toBe(false);
    expect(Object.keys(next)).toHaveLength(0);
    expect(Object.keys(h.stubs)).toHaveLength(0);
    expect(h.notices.join('\n')).toContain('保留');
  });

  it('通知は確かめていないことを書かない（「どちらも失われていません」と言い切らない）', async () => {
    const h = loadResolveConflict();
    await h.resolveConflict(MOUNT, REL, FULL, REMOTE, {});
    const said = h.notices.join('\n');
    expect(said).toContain('退避');
    expect(said).not.toContain('どちらも失われていません');
  });
});
