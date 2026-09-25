/**
 * tests/guest/loomCore.test.ts
 * Loom の核（`vfs_root/system/lib/loom_core.js`）の試験（T-0531 / T-0532）。
 *
 * 核は画面（system/apps/loom.html）とデーモン（system/services/loom.html）が**同じもの**を読む。
 * ここでは実ファイルをそのまま読み込んで（コピーしない）、
 *   1. 核に同梱した自己試験がすべて通ること
 *   2. 索引の行（本文を持たない札）でも系譜・「運んだか」の判定ができること
 *   3. 画面とデーモンが実際にこの核を読みに行くこと（置き場を動かしたときに片方だけ古いパスを指さないように）
 * を確かめる。
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(__dirname, '../../vfs_root');

/**
 * 核を実ファイルから読み込む。ゲストでは <script> で読まれて window.LoomCore になる。
 * このパッケージは ESM なので require では module.exports が立たない。ソースを評価して取り出す。
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function loadCore(): any {
  const src = readFileSync(resolve(ROOT, 'system/lib/loom_core.js'), 'utf-8');
  const mod: { exports: unknown } = { exports: {} };
  const win: Record<string, unknown> = {};
  new Function('module', 'window', src)(mod, win);
  if (!win.LoomCore) throw new Error('loom_core.js を評価しても window.LoomCore が立たなかった');
  return win.LoomCore;
}
const C = loadCore();

describe('loom_core', () => {
  it('同梱の自己試験がすべて通る', () => {
    const r = C.selfTest();
    expect(r.results).toEqual([]);
    expect(r.fail).toBe(0);
    expect(r.pass).toBeGreaterThan(20);
  });

  it('本文から導く派生値（索引の行が持つもの）', () => {
    const n = C.parseNode(
      [
        '---',
        'id: T-0001',
        'kind: task',
        'title: t',
        'status: doing',
        'parent: P-0001',
        '---',
        '',
        '## 計画',
        '',
        '- [x] a',
        '- [~] b',
        '- [ ] c',
        '',
        '## 進捗',
        '',
        '- 2026-09-25 10:00 Itera: 着手',
        '### レポート 2026-09-25 11:00',
        '**決定**',
        '- 決めた',
        '',
        '## 成果物',
        '',
      ].join('\n'),
    );
    const d = C.derive(n);
    expect(d.plan).toEqual({ done: 1, doing: 1, total: 3 });
    expect(d.reports).toBe(1);
    expect(d.ownRecaps).toBe(1);
    expect(d.lastLogAt).toBe('2026-09-25 10:00');
    expect(d.sections).toEqual(['計画', '進捗', '成果物']);
  });

  it('本文を持たない行だけで、系譜と「運んだか」を判定できる', () => {
    const row = (id: string, kind: string, status: string, parent: string, extra: Record<string, unknown> = {}) => {
      const meta = { id, kind, title: id, status, parent, ...extra };
      return { meta, d: C.derive({ meta, body: '' }) };
    };
    const p1 = row('P-0001', 'project', 'superseded', '');
    const p2 = row('P-0002', 'project', 'live', '', { supersedes: 'P-0001' });
    const t1 = row('T-0001', 'task', 'done', 'P-0001');
    const t2 = row('T-0002', 'task', 'review', 'P-0001');
    p1.d.completed = ['T-0001'];
    const L = C.lineage([p1, p2, t1, t2]);
    expect(L.owningProject(L.byId('T-0002')).meta.id).toBe('P-0002'); // 継承の後継に着地する
    expect(L.childrenOf('P-0002').map((n: { meta: { id: string } }) => n.meta.id)).toEqual(['T-0001', 'T-0002']);
    expect(L.deliveredAlready(L.byId('T-0001'))).toBe(true); // 親の履歴に「完了: T-0001」がある
    expect(L.deliveredAlready(L.byId('T-0002'))).toBe(false);
  });

  it('画面とデーモンは system/lib/loom_core.js を読む', () => {
    for (const p of ['system/apps/loom.html', 'system/services/loom.html']) {
      const src = readFileSync(resolve(ROOT, p), 'utf-8');
      expect(src, p).toContain('<script src="/system/lib/loom_core.js"></script>');
    }
    const app = readFileSync(resolve(ROOT, 'system/apps/loom.html'), 'utf-8');
    expect(app).toContain("path: 'system/services/loom.html'");
  });

  it('登録簿が新しい置き場を指す', () => {
    const apps = JSON.parse(readFileSync(resolve(ROOT, 'system/registry/apps.json'), 'utf-8'));
    const services = JSON.parse(readFileSync(resolve(ROOT, 'system/registry/services.json'), 'utf-8'));
    expect(apps.find((a: { id: string }) => a.id === 'loom').path).toBe('system/apps/loom.html');
    const d = services.find((s: { id: string }) => s.id === 'loom_daemon');
    expect(d.path).toBe('system/services/loom.html');
    expect(d.autoStart).toBe(true);
  });
});
