/**
 * src/core/cognitive/adapters/GeminiYieldStop.ts
 * Itera OS v2: Gemini の応急の停止語（行頭の yield タグ）。GeminiAdapter と GeminiInteractionsAdapter が使う
 */

import { Translator } from '../Translator';

/**
 * 応急の手当て（T-0877・2026-11-19）—— OS のチャットで、行頭の `<yield` を API の停止文字列にする。
 *
 * Gemini 4 Hydrogen は、終端タグ `<yield />` を書いたあとも思考を挟んで書き続ける（T-0851）。プロンプトでは止まらない
 * （T-0854・T-0858）。そこで Gemini に限り、API が用意している仕組み（`stopSequences`）で生成を終わらせる。
 *
 *   - 掛けるのはエンジンのターン（`origin.engineTurn`）だけ。`MetaOS.llm.generate` の出力は LPML ではない。
 *     見るのは名前（`caller`）ではない —— ルートでないエンジンのターンにも掛かる（T-0903）。
 *   - Gemini は停止文字列を出力に含めない。止まったあとに `\n<yield />` を流して、モデルが書いた形に戻す
 *     （履歴のモデルのターンが終端タグを欠かないようにするため。実行には要らない）。
 *     ただし頭の改行だけは出力に残ることがある（Hydrogen の実測で 15 回中 9 回）。そのときは改行を重ねない。
 *   - Gemini は、停止文字列で止まったのか自然に終わったのかを返さない（どちらも `STOP`）。戻すのは、
 *     `STOP` で、かつ出力に最上位の終端タグが無いときだけ（`</ask>` や `<finish />` で終わったターンには足さない）。
 *     終端タグの有無は Translator に訊く（終端タグの定義をここに写さない）。
 *
 * 🔴 分かっていて残している制約: API の停止文字列は場所を見ない。`<write>` などの中身に `<yield` で始まる行があると
 *    そこで切れる（T-0859 の実測）。切れた道具は閉じていないので実行されず、「閉じていない」という失敗が返る（T-0878）。
 *    つまり Gemini は、その行を含む中身を書けない。行頭に限ってあるので、文中での言及では切れない。
 *
 * 外す条件: 終端タグでの打ち切りを全アダプタ共通の受け口に置いたとき（T-0859 の B 案）、または Hydrogen が直ったとき。
 * Interactions の経路（GeminiInteractionsAdapter）にも同じ規則で掛ける（T-0896。送る鍵は `generation_config.stop_sequences`、
 * 自然な終わりと停止文字列での終わりはどちらも `completed`）。
 *   - 上流が保存する応答は停止文字列の手前までで、ここで戻したタグは入らない（2026-11-19 実測・probe25）。
 *     手元の履歴は戻した形なので、鎖の指紋は戻した形で作る（GeminiInteractionsAdapter）。
 */
export const GEMINI_YIELD_STOP = '\n<yield';
const GEMINI_YIELD_TAG = '<yield />';
/** 停止文字列で削られた分として流す文字（出力が改行で終わっているときは、タグだけを流す） */
export const GEMINI_YIELD_RESTORED = '\n' + GEMINI_YIELD_TAG;
/** Gemini が受け付ける停止文字列の本数（6 本で 400。generateContent は T-0859、Interactions は T-0896 の実測） */
const GEMINI_MAX_STOP_SEQUENCES = 5;

const terminalReader = new Translator();

/**
 * 設定の停止文字列の並びに、行頭の yield を足す。
 *   - on: この生成に停止語が効いているか（足せた・設定に既に在った）。上限まで埋まっていて足せなければ false
 *   - stops: 送る並び。設定のままでよいときは null（設定に既に在る・足せない）
 */
export function addYieldStop(configured: unknown): { stops: string[] | null; on: boolean } {
  const own: string[] = Array.isArray(configured)
    ? configured.filter((s: unknown): s is string => typeof s === 'string')
    : [];
  if (own.includes(GEMINI_YIELD_STOP)) return { stops: null, on: true };
  if (own.length < GEMINI_MAX_STOP_SEQUENCES) return { stops: [...own, GEMINI_YIELD_STOP], on: true };
  return { stops: null, on: false };
}

/**
 * 停止文字列で削られた分として流す文字。出力に最上位の終端タグが在れば null（自然に終わったターンには足さない）。
 * 呼ぶのは、停止語が効いていて、止まった理由が「普通の終わり」（STOP・completed）のときだけ。
 * 終端タグの有無は Translator に訊く（終端タグの定義をここに写さない）。
 */
export function yieldRestoration(written: string): string | null {
  if (terminalReader.parse(written).terminalTag !== null) return null;
  return written.endsWith('\n') ? GEMINI_YIELD_TAG : GEMINI_YIELD_RESTORED;
}
