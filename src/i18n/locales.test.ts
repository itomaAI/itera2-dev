import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { EN } from './messages_en';
import { isMessage, type Message } from './i18n';

/**
 * 配信する言語ファイル（vfs_root/system/locales/*.json）の検査（P-0046 / T-0545）。
 * 英語の辞書に鍵を足したら、全言語へ足さないとここで落ちる。英語に無い鍵（古くなった鍵）も落とす。
 * 引数の印（{name}）は英語と同じものを使う（欠けると文が壊れ、余ると {x} のまま出る）。
 */
const DIR = resolve(__dirname, '../../vfs_root/system/locales');
const EXPECTED = ['de', 'es', 'fr', 'ja', 'ko', 'zh-Hans', 'zh-Hant'];

const placeholders = (m: Message): string[] => {
  const texts = typeof m === 'string' ? [m] : Object.values(m).filter((v): v is string => typeof v === 'string');
  const found = new Set<string>();
  for (const text of texts) for (const match of text.matchAll(/\{([A-Za-z0-9_]+)\}/g)) found.add(match[1]);
  return [...found].sort();
};

const files = readdirSync(DIR).filter((f) => f.endsWith('.json'));

describe('配信する言語ファイル', () => {
  it('8 言語（英語はホスト）がそろっている', () => {
    expect(files.map((f) => f.replace(/\.json$/, '')).sort()).toEqual(EXPECTED);
  });

  for (const file of files) {
    describe(file, () => {
      const parsed = JSON.parse(readFileSync(resolve(DIR, file), 'utf-8'));
      const messages = parsed.messages as Record<string, unknown>;

      it('meta.name と meta.englishName を持つ', () => {
        expect(typeof parsed.meta?.name).toBe('string');
        expect(typeof parsed.meta?.englishName).toBe('string');
      });

      it('英語と同じ鍵を持つ（欠けも余りも無い）', () => {
        const want = Object.keys(EN).sort();
        const have = Object.keys(messages).sort();
        expect(want.filter((k) => !have.includes(k))).toEqual([]);
        expect(have.filter((k) => !want.includes(k))).toEqual([]);
      });

      it('どの項目も形が正しく、引数の印が英語と同じ', () => {
        const bad: string[] = [];
        for (const [key, value] of Object.entries(messages)) {
          if (!isMessage(value)) {
            bad.push(`${key}: shape`);
            continue;
          }
          const en = (EN as Record<string, Message>)[key];
          if (en && placeholders(value).join() !== placeholders(en).join()) bad.push(`${key}: placeholders`);
        }
        expect(bad).toEqual([]);
      });

      it('HTML を含まない（訳文は文字列として扱うが、念のため入口でも止める）', () => {
        const withTags = Object.entries(messages).filter(([, v]) => /<[a-zA-Z/!]/.test(JSON.stringify(v)));
        expect(withTags.map(([k]) => k)).toEqual([]);
      });
    });
  }
});
