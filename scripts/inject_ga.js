#!/usr/bin/env node
/**
 * 配信時にだけ Google Analytics（gtag.js）のタグを dist/index.html へ差し込む（T-0320・2026-09-01）。
 *
 * ソース（index.html）には入れない。deploy.yml が Build のあとに呼び、リポジトリ変数 GA_MEASUREMENT_ID が
 * 空なら呼ばれもしない。ローカルの `npm run build` / `npm run dev` は無変更。
 *
 * 使い方: GA_MEASUREMENT_ID=G-XXXXXXX node scripts/inject_ga.js dist/index.html
 */
import fs from 'node:fs';

const target = process.argv[2] ?? 'dist/index.html';
const id = (process.env.GA_MEASUREMENT_ID ?? '').trim();

if (!id) {
  console.log('[inject_ga] GA_MEASUREMENT_ID が空。何もしない');
  process.exit(0);
}
if (!/^G-[A-Z0-9]+$/.test(id)) {
  console.error(`[inject_ga] 測定 ID の形が変: ${JSON.stringify(id)}`);
  process.exit(1);
}

const html = fs.readFileSync(target, 'utf8');
if (html.includes('googletagmanager.com/gtag/js')) {
  console.error('[inject_ga] 既にタグが入っている。二重に入れない');
  process.exit(1);
}
// charset の宣言を先頭に残す（HTML の作法）。無ければ <head> の直後
const charset = html.match(/<meta charset=[^>]*>/);
const anchor = charset ? charset[0] : '<head>';
const at = html.indexOf(anchor);
if (at < 0) {
  console.error('[inject_ga] <head> が見つからない');
  process.exit(1);
}

const snippet = [
  '',
  '    <!-- Google tag (gtag.js) — 配信時に scripts/inject_ga.js が注入。ソースには無い -->',
  `    <script async src="https://www.googletagmanager.com/gtag/js?id=${id}"></script>`,
  '    <script>',
  '      window.dataLayer = window.dataLayer || [];',
  '      function gtag(){dataLayer.push(arguments);}',
  "      gtag('js', new Date());",
  `      gtag('config', '${id}');`,
  '    </script>',
].join('\n');

const cut = at + anchor.length;
fs.writeFileSync(target, html.slice(0, cut) + snippet + html.slice(cut));
console.log(`[inject_ga] ${target} に ${id} のタグを入れた`);
