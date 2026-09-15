/**
 * src/core/sys/registryMerge.ts
 * 登録簿の層を重ねる規則（純関数）。
 *
 * 設定（ConfigManager）は「ファイル単位で深く併合し、書くのは下の層との差分だけ」。
 * 登録簿は配列なので単位が違う —— **`id` で突き合わせた項目**が単位で、
 *   - 読むとき: 後の層は「持っている鍵だけ」勝つ（`overlayEntry`）。
 *     `{ id, autoStart: false }` だけ置けば、配信のデーモンを止められる。
 *     項目を丸ごと置き換える規則だと、利用者の層が `path` の写しを持つことになり、
 *     配信側が `path` を変えたとき利用者の層が古い写しで勝ち続ける（層に分けた意味が消える）。
 *   - 書くとき: 下の層に重ねると望む項目になる **最小の差分** だけを書く（`diffEntry`）。
 * AppRegistry（apps / services）と CognitiveManager（llm_profiles）が同じ規則を使う。
 */

export interface RegistryEntry {
  id: string;
  [key: string]: unknown;
}

/** 値としての同一性。キーの並びは見ない（ConfigManager と同じ考え方）。 */
export function isSameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => isSameValue(v, b[i]));
  }
  const ka = Object.keys(a as object);
  const kb = Object.keys(b as object);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && isSameValue((a as any)[k], (b as any)[k]));
}

/** 1 項目を重ねる。後の層は持っている鍵だけ勝ち、持っていない鍵は下の層の値が残る。 */
export function overlayEntry<T extends object>(below: T | undefined, layer: Partial<T>): T {
  return below ? { ...below, ...layer } : ({ ...layer } as T);
}

/**
 * 「`below` に重ねると `next` になる」最小の項目。`id` は常に残す。
 * 下の層に無い項目（利用者が足したもの）は丸ごと返す。
 * 下の層と同じ値に戻した鍵は差分から落ちる（＝「上書きしていない」に戻る）。
 */
export function diffEntry<T extends RegistryEntry>(below: T | undefined, next: T): T {
  if (!below) return { ...next };
  const out: any = { id: next.id };
  for (const key of Object.keys(next)) {
    if (key === 'id') continue;
    if (!isSameValue((below as any)[key], (next as any)[key])) out[key] = (next as any)[key];
  }
  return out as T;
}

/** 差分が `id` だけ＝下の層をそのまま使っている。 */
export function isEmptyDiff(entry: RegistryEntry): boolean {
  return Object.keys(entry).every((k) => k === 'id');
}

/**
 * LLM の提供者（`llm_profiles.json` の `providers[]`）を重ねる。
 * `models` は丸ごと差し替え・`defaultCapabilities` は浅く併合・`defaultConfig` は差し替え・
 * 知らない `id` は足す —— CognitiveManager がコードの `PROVIDERS` に VFS を重ねていたときと同じ規則を、
 * 層の数だけ繰り返す。`acc` は書き換えず、新しい配列を返す。
 */
export function overlayProviders(acc: any[], providers: unknown): any[] {
  if (!Array.isArray(providers)) return acc;
  const merged = acc.map((p) => ({ ...p }));
  for (const layerProv of providers) {
    if (!layerProv || typeof layerProv !== 'object' || !(layerProv as any).id) continue;
    const base = merged.find((p) => p.id === (layerProv as any).id);
    if (!base) {
      merged.push({ ...(layerProv as any) });
      continue;
    }
    const lp = layerProv as any;
    if (Array.isArray(lp.models)) base.models = lp.models;
    if (lp.defaultCapabilities) {
      base.defaultCapabilities = { ...(base.defaultCapabilities || {}), ...lp.defaultCapabilities };
    }
    if (lp.defaultConfig) base.defaultConfig = lp.defaultConfig;
  }
  return merged;
}
