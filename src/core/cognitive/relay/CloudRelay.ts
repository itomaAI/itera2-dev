/**
 * src/core/cognitive/relay/CloudRelay.ts
 * この配布物のクラウド（itera2 の Functions `llmProxy`）が用意した LLM 中継へ話すための解決処理。
 *
 * ■ この層が引き受けること
 * 利用者は「smart / standard / light」といった**別名**しか知らない。実モデル名も鍵も中継の側にある。
 * ここでやるのは 2 つだけである。
 *   1. 別名から「どの形式で話すか」（anthropic / openai / google）を決める
 *   2. 中継の URL を組み立てる
 *
 * ■ 推測しない
 * 別名が分からないとき、形式を当てずっぽうで選ぶと、上流は 400 を返すか解釈できない応答を返す。
 * どちらも利用者からは「AI が壊れた」ようにしか見えない。分からないときは null を返し、
 * 呼び出し側が理由を出して止める。
 *
 * ■ 出どころ
 * ミャク楽 `agent/src/core/cognitive/relay/MyakurakuRelay.ts` を汎用にしたもの（T-0421）。
 * 違いは「繋ぎ先の決め方」だけ —— あちらは `tenant.json` の projectId から URL を組み、
 * こちらは `system/config/cloud.json` の `functionsBase`（web 検索と同じ出どころ）に関数名を足す。
 * 繋ぎ先の無い配布物（itera2-dev）では中継は存在しない（提供者一覧にも出ない）。
 */

import { BaseLLMAdapter, type LlmConfig } from '../adapters/BaseAdapter';
import type { SystemLogger } from '../../state/SystemLogger';

/** `system/config/llm.json` の `model` に前置きされるプロバイダ名（`itera/smart`） */
export const RELAY_PROVIDER_ID = 'itera';

/** 中継の関数名（itera2 `functions/src/llmProxy.ts` の export 名） */
export const RELAY_FUNCTION_NAME = 'llmProxy';

/** 繋ぎ先を配る設定ファイル（web 検索のデーモンと同じ出どころ。itera2 だけが配る） */
export const CLOUD_CONFIG_PATH = 'system/config/cloud.json';

/** 最後に取れた台帳の控えの置き場（localStorage）。所有者が変わったら捨てる（認証アダプタの Detach） */
export const RELAY_CATALOG_STORAGE_KEY = 'itera_relay_catalog';

/** 中継が受け付ける形式。台帳（Firestore `llmModels`）の `provider` と同じ語 */
export type RelayUpstream = 'anthropic' | 'openai' | 'google';

const SUPPORTED_UPSTREAMS: RelayUpstream[] = ['anthropic', 'openai', 'google'];

export interface RelayModelEntry {
  id: string;
  name?: string;
  aliases?: string[];
  description?: string;
  upstream: RelayUpstream;
  contextTokens?: number;
  capabilities?: any;
  order?: number;
}

/**
 * 中継の基点 URL を組み立てる。`functionsBase` が無ければ null（推測しない）。
 */
export function buildRelayBaseUrl(functionsBase: string | null | undefined): string | null {
  if (typeof functionsBase !== 'string') return null;
  const trimmed = functionsBase.trim().replace(/\/+$/, '');
  if (!trimmed) return null;
  return `${trimmed}/${RELAY_FUNCTION_NAME}`;
}

/**
 * 利用者の指定（`smart` や `賢い`）から台帳の 1 件を決める。
 * 見つからない・形式が不明なものは null を返す。
 */
export function resolveRelayModel(models: any, requested: string | null | undefined): RelayModelEntry | null {
  if (!Array.isArray(models)) return null;
  if (typeof requested !== 'string') return null;

  const wanted = requested.trim();
  if (!wanted) return null;

  const matched = models.find((model: any) => {
    if (!model || typeof model !== 'object') return false;
    if (model.id === wanted) return true;
    if (model.name === wanted) return true;
    return Array.isArray(model.aliases) && model.aliases.includes(wanted);
  });

  if (!matched || typeof matched.id !== 'string' || !matched.id) return null;
  if (!SUPPORTED_UPSTREAMS.includes(matched.upstream)) return null;

  return matched as RelayModelEntry;
}

/**
 * 中継へ繋げないときに Engine へ挿すアダプタ。
 *
 * ここで「とりあえず動く何か」を返さないのは、黙って別のモデルへ切り替わるのが
 * いちばん分かりにくい壊れ方だからである。生成しようとした時点で理由を出す。
 */
export class UnavailableRelayAdapter extends BaseLLMAdapter {
  private reason: string;

  constructor(reason: string, config: LlmConfig = {}, logger: SystemLogger | null = null) {
    super(config, logger, null);
    this.reason = reason;
  }

  async generateStream(): Promise<void> {
    throw new Error(`The LLM is not available: ${this.reason}`);
  }
}

/** 一覧を取り直す間隔。運営が台帳を変えてからホストに出るまでの遅れがこれになる。 */
export const RELAY_CATALOG_TTL_MS = 5 * 60 * 1000;

/** 取れなかったときに次を試すまでの間隔。サインアウト中に毎回叩かないための歯止めでもある。 */
export const RELAY_CATALOG_RETRY_MS = 30 * 1000;

/** 認証ヘッダの取り方。取れないとき（未サインイン等）は null を返す。 */
export type RelayAuthHeaderProvider = () => Promise<Record<string, string> | null>;

/**
 * 中継の `GET /models` の応答を、こちら側の形へ写す。
 *
 * 中継は上流の種別を **`provider`** という名前で返す（台帳の語）。こちらは `upstream` と呼んでいるため、
 * ここで写し替える。**種別が分からない項目は捨てる。**
 *
 * @returns 1 件以上取れたときだけ配列を返す。空や形が違うときは null（＝取れなかった）
 */
export function normalizeRelayCatalog(payload: any): RelayModelEntry[] | null {
  const list = Array.isArray(payload) ? payload : Array.isArray(payload?.models) ? payload.models : null;
  if (!list) return null;

  const entries: RelayModelEntry[] = [];

  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue;

    const id = typeof raw.id === 'string' ? raw.id.trim() : '';
    const upstream = typeof raw.upstream === 'string' ? raw.upstream : raw.provider;
    if (!id) continue;
    if (typeof upstream !== 'string' || !SUPPORTED_UPSTREAMS.includes(upstream as RelayUpstream)) continue;

    const aliases = Array.isArray(raw.aliases)
      ? raw.aliases.filter((alias: any) => typeof alias === 'string' && alias.trim())
      : [];

    const entry: RelayModelEntry = {
      id,
      name: typeof raw.name === 'string' && raw.name ? raw.name : id,
      aliases,
      upstream: upstream as RelayUpstream,
    };

    if (typeof raw.description === 'string') entry.description = raw.description;
    if (typeof raw.contextTokens === 'number') entry.contextTokens = raw.contextTokens;
    if (raw.capabilities && typeof raw.capabilities === 'object') entry.capabilities = raw.capabilities;
    if (typeof raw.order === 'number') entry.order = raw.order;

    entries.push(entry);
  }

  // 空一覧は「取れなかった」と同じに扱う。台帳は運営が Firestore に定義したものだけで、
  // 空なら運営がまだ種をまいていないか読めていない（中継は 503 catalog_unavailable）。
  // どちらにせよ、手元にある最後の台帳を空で上書きしてはいけない
  return entries.length ? entries : null;
}

/**
 * 中継から選択肢の一覧を取る。
 *
 * **失敗を例外にしない。** 呼び出し側にできるのは「最後に取れた控えのまま続ける」ことだけで、
 * ここで投げると設定画面が開かなくなる。取れなければ null を返す。
 */
export async function fetchRelayCatalog(
  baseUrl: string,
  getAuthHeaders: RelayAuthHeaderProvider,
  deps: { fetchImpl?: typeof fetch } = {},
): Promise<RelayModelEntry[] | null> {
  const fetchImpl = deps.fetchImpl || (typeof fetch === 'function' ? fetch : null);
  if (!fetchImpl || !baseUrl) return null;

  try {
    const headers = await getAuthHeaders();
    if (!headers) return null;

    const res = await fetchImpl(`${baseUrl}/models`, { method: 'GET', headers });
    if (!res || !res.ok) return null;

    return normalizeRelayCatalog(await res.json());
  } catch (e) {
    return null;
  }
}

/** 最後に取れた台帳を残す先（localStorage 等）。読めない・書けないときは投げず null／無視でよい。 */
export interface RelayCatalogStore {
  get(): string | null;
  set(value: string): void;
}

/**
 * 運営の台帳の控え。
 *
 * コード側には選択肢を一切書かない（運営が定義したモデルだけが存在する）。そのため
 * 取れない窓（起動直後・オフライン・サインアウト中）を埋めるのは、**最後に取れた台帳**だけである。
 * store を渡すとそれを永続化し、次回の起動時は取りに行く前からその内容を返す。
 * 取れなかったときに**直前の内容を捨てない**のが要点 —— 一時的な失敗で選択肢が黙って消えると、
 * 利用者からは「設定が壊れた」ように見える。
 */
export class RelayCatalogCache {
  private entries: RelayModelEntry[] | null = null;
  private expiresAt = 0;
  private inflight: Promise<RelayModelEntry[] | null> | null = null;
  private readonly store: RelayCatalogStore | null;

  constructor(store: RelayCatalogStore | null = null) {
    this.store = store;
    this.entries = this.restore();
  }

  private restore(): RelayModelEntry[] | null {
    if (!this.store) return null;
    try {
      const raw = this.store.get();
      if (!raw) return null;
      // 中継の応答と同じ形で保存しているので、同じ検査を通す（壊れた控えは捨てる）
      return normalizeRelayCatalog(JSON.parse(raw));
    } catch {
      return null;
    }
  }

  private persist(entries: RelayModelEntry[]): void {
    if (!this.store) return;
    try {
      this.store.set(JSON.stringify(entries));
    } catch {
      /* 書けなくても台帳そのものは使える */
    }
  }

  /** いま持っている内容（取りに行かない）。 */
  public peek(): RelayModelEntry[] | null {
    return this.entries;
  }

  /** 次の呼び出しで必ず取り直す。 */
  public invalidate(): void {
    this.expiresAt = 0;
  }

  public async get(
    load: () => Promise<RelayModelEntry[] | null>,
    now: number = Date.now(),
  ): Promise<RelayModelEntry[] | null> {
    if (now < this.expiresAt) return this.entries;
    if (this.inflight) return this.inflight;

    this.inflight = (async () => {
      try {
        const fetched = await load();
        if (fetched && fetched.length) {
          this.entries = fetched;
          this.expiresAt = now + RELAY_CATALOG_TTL_MS;
          this.persist(fetched);
        } else {
          this.expiresAt = now + RELAY_CATALOG_RETRY_MS;
        }
        return this.entries;
      } finally {
        this.inflight = null;
      }
    })();

    return this.inflight;
  }
}
