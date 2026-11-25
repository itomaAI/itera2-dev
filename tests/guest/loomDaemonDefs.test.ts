/**
 * Loom デーモン（system/services/loom.html）の道具の定義は英語（T-0912 段 4）。
 *
 * 定義は、登録のたび・会話を空にするたびに会話へ入る（OS が台帳から置く）。日本語は同じ中身でもトークンが多いので、
 * 配信しているアプリの定義は英語で書く。ただし Loom の札のファイルに実際に書かれる語（節の名前・見出し・出来事の語）は
 * 値なので、定義の中でもそのまま残す —— 訳すと、AI が渡す値と札の中身が食い違う。
 *
 *   - 定義 7 本を切り出せる（切り出しが空のまま通り続けない）
 *   - 残してよい語を除くと、日本語（かな・漢字・全角の記号）が 1 行も残らない
 *   - 残してよい語は、どれも核かデーモンが実際に使う語である（表だけに残った古い語が無い）
 *   - 道具の組の説明（登録簿の description）も英語
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(__dirname, '../../');
const read = (p: string) => readFileSync(resolve(ROOT, p), 'utf8');

const daemon = read('vfs_root/system/services/loom.html');
const core = read('vfs_root/system/lib/loom_core.js');

// 札のファイルに実際に書かれる語（値）。定義の中でも訳さない
const BOARD_WORDS = [
  '確認事項',
  '追加要望',
  '成果物',
  'レポート',
  '進捗',
  '履歴',
  '計画',
  '依頼',
  '意図',
  '総括',
  '追記',
  '起票',
  '分解',
  '分岐',
];
// かな・漢字に加えて、全角の記号（「」（）・など）も数える
const JP = /[\u3000-\u303f\u3040-\u30ff\u4e00-\u9fff\uff00-\uffef]/;
const DEF_RE = /<define_tag name="[^"]+">[\s\S]*?<\/define_tag>/g;

describe('Loom デーモンの道具の定義（define_tag）', () => {
  const defs = daemon.match(DEF_RE) ?? [];
  const nameOf = (d: string) => /<define_tag name="([^"]+)">/.exec(d)?.[1];

  it('7 本の定義を切り出せる', () => {
    expect(defs.map(nameOf)).toEqual([
      'loom_list',
      'loom_search',
      'loom_tree',
      'loom_update',
      'loom_append',
      'loom_create',
      'loom_status',
    ]);
  });

  it('定義は英語 —— 札に書かれる語を除くと、日本語の行が残らない', () => {
    for (const d of defs) {
      let rest = d;
      for (const w of BOARD_WORDS) rest = rest.split(w).join('');
      const left = rest.split('\n').filter((l) => JP.test(l));
      expect(left, String(nameOf(d))).toEqual([]);
    }
  });

  it('残してよい語は、定義の中で使われていて、核かデーモンの定義の外にも在る', () => {
    const all = defs.join('\n');
    const outside = daemon.replace(DEF_RE, '') + '\n' + core;
    for (const w of BOARD_WORDS) {
      expect(all.includes(w), `定義に無い語: ${w}`).toBe(true);
      expect(outside.includes(w), `核にもデーモンにも無い語: ${w}`).toBe(true);
    }
  });

  it('道具の組の説明（登録簿の Loom の description）も英語', () => {
    const apps = JSON.parse(read('vfs_root/system/registry/apps.json')) as { id: string; description?: string }[];
    const loom = apps.find((a) => a.id === 'loom');
    expect(loom?.description).toBeTruthy();
    expect(JP.test(String(loom?.description))).toBe(false);
  });
});
