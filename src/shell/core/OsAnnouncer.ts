/**
 * src/shell/core/OsAnnouncer.ts
 * OS の状態の告知（P-0047 / T-0539）。
 *
 * OS はアプリを感知しない。依存の向きは「アプリ → OS」の一方向で、OS は特定のアプリを想定しない。
 * ただし OS は「自分の状態が変わった」ことだけを全プロセスへ告げてよい。聞くか・どう反応するか・無視するかはアプリが決める
 * （既にある vfs_mutation・nav_changed と同じ形）。
 *
 * 規則: 告知の名前は「持ち主_changed」。出すのは値の持ち主で、中身は「何が変わったか」だけ。
 *   - config_changed { categories } … ConfigManager。値が実際に変わった区分だけ（判定は ConfigManager にある。T-0304）。
 *     値そのものは配らない。受け手は getConfig で読み直す —— 値を配ると、層の重ね合わせの判定がゲストへ漏れる
 *   - theme_changed {} … ThemeService。テーマは設定の値ではなくホストが導いたもの（CSS 変数）なので、当て終えてから告げる
 *   - nav_changed { canBack, canForward, current } … NavHistory。戻る／進むの活性（T-0453 で入った形をそのまま移した）
 *   - registry_changed { registries } … AppRegistry（'apps' / 'services'）と FileAssociationResolver（'associations'）。
 *     名前は getRegistry の引数と同じ。値が実際に変わったものだけ。受け手は getRegistry で読み直す（T-0540）
 *
 * OS がゲストへ告げるものの一覧はこのファイルである。ただし vfs_mutation だけは別（EventOrchestrator が出す）——
 * 状態の変化ではなく VFS の変更 1 件ごとの流れで、件数が多く、system/logs/ を除く判定や容量表示の更新と同居しているため。
 *
 * この配線は何も判定しない（「配線は判定してはいけません」）。持ち主の知らせに名前を付けて配るだけ。
 */

export const CONFIG_CHANGED = 'config_changed';
export const THEME_CHANGED = 'theme_changed';
export const NAV_CHANGED = 'nav_changed';
export const REGISTRY_CHANGED = 'registry_changed';

export interface RegistryChangedPayload {
  registries: string[];
}

export interface ConfigChangedPayload {
  categories: string[];
}

export interface OsAnnouncerDeps {
  configManager: { onUpdate(callback: (config: unknown, changed: ReadonlySet<string>) => void): () => void };
  themeService: { onApplied(callback: () => void): () => void };
  navHistory: {
    onChange(
      callback: (s: { canBack: boolean; canForward: boolean; current: { uri: string; pid: string } | null }) => void,
    ): () => void;
  };
  appRegistry: { onChange(callback: (changed: ReadonlySet<string>) => void): () => void };
  associations: { onChange(callback: () => void): () => void };
  broadcast(eventName: string, payload: unknown): void;
}

/** 告知を配線する。戻り値を呼ぶと外れる。 */
export function wireOsAnnouncements(deps: OsAnnouncerDeps): () => void {
  const offConfig = deps.configManager.onUpdate((_config, changed) => {
    const payload: ConfigChangedPayload = { categories: [...changed] };
    deps.broadcast(CONFIG_CHANGED, payload);
  });
  const offTheme = deps.themeService.onApplied(() => deps.broadcast(THEME_CHANGED, {}));
  // 中身はこれまでと同じ 3 つだけ（NavState の index / length は配らない）
  const offNav = deps.navHistory.onChange((s) =>
    deps.broadcast(NAV_CHANGED, { canBack: s.canBack, canForward: s.canForward, current: s.current }),
  );
  const offRegistry = deps.appRegistry.onChange((changed) => {
    const payload: RegistryChangedPayload = { registries: [...changed] };
    deps.broadcast(REGISTRY_CHANGED, payload);
  });
  const offAssociations = deps.associations.onChange(() => {
    const payload: RegistryChangedPayload = { registries: ['associations'] };
    deps.broadcast(REGISTRY_CHANGED, payload);
  });
  return () => {
    offConfig();
    offTheme();
    offNav();
    offRegistry();
    offAssociations();
  };
}
