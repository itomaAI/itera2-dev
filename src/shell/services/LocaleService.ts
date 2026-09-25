/**
 * src/shell/services/LocaleService.ts
 * UI の言語（`appearance.locale`）の持ち主（P-0046 / T-0545）。
 *
 * - 言語ファイルを層（LOCALE_LAYERS。既定 `system/locales` → `user/locales`）と言語の鎖（`ja` → `ja-JP`）の順に重ね、
 *   ホストの辞書（i18n）へ渡す。英語はホストの TS にあるので、ファイルが 1 つも無くても英語で動く
 * - ファイルの形: `{ "meta": { "name": "日本語", "englishName": "Japanese" }, "messages": { "key": "文" } }`
 * - 設定の `appearance` が変わったとき（判定は ConfigManager。T-0304）と、言語ファイルが書かれたときに読み直す
 * - ホストの `<html lang>` もここで合わせる（以前は ThemeService が書いていた）
 *
 * `preferences.language`（AI の応答言語）は見ない。UI の言語とは別である（P-0046）。
 */

import type { ConfigManager } from '../../core/sys/ConfigManager';
import type { VfsService } from '../../core/vfs/VfsService';
import type { VfsEventBus } from '../../core/vfs/VfsEventBus';
import { SYSTEM_PRINCIPAL } from '../../core/vfs/types';
import { LOCALE_LAYERS } from '../../config/config_layers';
import {
  i18n as defaultI18n,
  canonicalLocale,
  localeChain,
  sanitizeMessages,
  type I18n,
  type Messages,
} from '../../i18n/i18n';

export interface LocaleFileMeta {
  name?: string;
  englishName?: string;
}

export class LocaleService {
  private readonly configManager: ConfigManager;
  private readonly vfs: VfsService;
  private readonly eventBus: VfsEventBus;
  private readonly layers: readonly string[];
  private readonly target: I18n;
  private loadSeq = 0;
  private loadedLocale: string | null = null;

  constructor(
    configManager: ConfigManager,
    vfs: VfsService,
    eventBus: VfsEventBus,
    opts: { layers?: readonly string[]; target?: I18n } = {},
  ) {
    this.configManager = configManager;
    this.vfs = vfs;
    this.eventBus = eventBus;
    this.layers = opts.layers ?? LOCALE_LAYERS;
    this.target = opts.target ?? defaultI18n;
  }

  /** 設定に書かれている UI の言語（正規の形）。 */
  currentSetting(): string {
    const appearance = this.configManager.get('appearance') as { locale?: string } | undefined;
    return canonicalLocale(appearance?.locale || 'en');
  }

  start(): void {
    this.configManager.onUpdate((_config, changed) => {
      // 自分が見ているのは appearance だけ（T-0304）。その中でも言語が変わったときだけ読み直す
      if (!changed.has('appearance')) return;
      if (this.currentSetting() === this.loadedLocale) return;
      void this.load();
    });
    this.eventBus.subscribe((mutations) => {
      const touched = mutations.some(
        (m) =>
          typeof m.path === 'string' &&
          m.path.endsWith('.json') &&
          this.layers.some((dir) => m.path.startsWith(`${dir}/`)),
      );
      if (touched) void this.load();
    });
  }

  /** 今の設定の言語を読み、辞書を差し替える。立て続けに呼ばれたら最後の 1 回だけが効く。 */
  async load(): Promise<void> {
    const seq = ++this.loadSeq;
    const locale = this.currentSetting();
    const overlay = await this.readOverlay(locale);
    if (seq !== this.loadSeq) return;
    this.loadedLocale = locale;
    if (typeof document !== 'undefined') document.documentElement.lang = locale;
    this.target.set(locale, overlay);
  }

  /** 言語の鎖 × 層 の順に重ねる（一般 → 個別、各段で system → user）。後が勝つ。 */
  async readOverlay(locale: string): Promise<Messages> {
    const merged: Messages = {};
    for (const tag of localeChain(locale)) {
      for (const dir of this.layers) {
        const path = this.findFile(dir, tag);
        if (!path) continue;
        try {
          const parsed = JSON.parse(await this.vfs.readFile(SYSTEM_PRINCIPAL, path));
          Object.assign(merged, sanitizeMessages(parsed?.messages));
        } catch (e) {
          // 壊れたファイルは飛ばす（その言語の文は下の層か英語に落ちる）
          console.warn(`[LocaleService] Skipped an unreadable locale file: ${path}`, e);
        }
      }
    }
    return merged;
  }

  /** `<dir>/<tag>.json` を大文字小文字を問わず探す（`zh-hans.json` でも `zh-Hans` に当たる）。 */
  private findFile(dir: string, tag: string): string | null {
    const exact = `${dir}/${tag}.json`;
    if (this.vfs.exists(SYSTEM_PRINCIPAL, exact)) return exact;
    if (!this.vfs.exists(SYSTEM_PRINCIPAL, dir)) return null;
    try {
      const want = `${tag}.json`.toLowerCase();
      for (const entry of this.vfs.listFiles(SYSTEM_PRINCIPAL, { path: dir })) {
        const p = typeof entry === 'string' ? entry : entry.path;
        const name = p.split('/').pop() || '';
        if (name.toLowerCase() === want) return p.includes('/') ? p : `${dir}/${name}`;
      }
    } catch {
      /* 読めないディレクトリは無いものとして扱う */
    }
    return null;
  }
}
