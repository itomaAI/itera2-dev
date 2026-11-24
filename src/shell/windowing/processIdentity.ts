/**
 * src/shell/windowing/processIdentity.ts
 * プロセスの同一性（T-0903）—— 「何のアプリか」と「どの個体か（pid）」を決める規則。純関数。
 *
 * プロセスの記録は 3 つを別々に持つ:
 *   app    … 何のアプリか。VFS の主体・特権・端末ごとの記録はここから決まる（個体からは決めない）
 *   engine … どのエンジンに仕えるか（既定はルート。起こした者から引き継ぐ）
 *   pid    … どの個体か。名前空間は OS に 1 つ。IPC の宛先・道具の組・変更の個体の印はこれ
 *
 * ■ アプリの決め方
 *   登録簿にそのパスが在ればその id（apps → services）→ ホームのパスなら `home` →
 *   起こすときに付けた名前 → パスから（`app_<パス>`）
 *   登録簿を先に見るのは、特権が「何のファイルか」で決まるようにするため —— 起こした者が付けた名前では決めない。
 *   登録簿に無いパスには、付けた名前のほかに身元が無い（付けた名前がそのままアプリになる）。
 *
 * ■ pid の決め方
 *   名前の指定が在ればそれ（同じアプリに別の名前を付けて、個体を複数起こせる）。
 *   無ければ `<app>`・`<app>-2`・`<app>-3` … の順に見て、空いているか、同じ（アプリ, エンジン）の個体が居る
 *   最初のものを使う。エンジンが 1 つの間は、最初の候補で必ず決まる。
 */

export interface RegistryEntryLike {
  id: string;
  path: string;
}

/** 登録簿のうち、ここで使う分（AppRegistry が満たす） */
export interface AppLookup {
  getAllApps(): RegistryEntryLike[];
  getAllServices(): RegistryEntryLike[];
}

export interface AppIdentity {
  /** 何のアプリか */
  app: string;
  /** 種類の指定が無いときの種類（登録簿の services に在ればデーモン） */
  defaultType: 'app' | 'daemon';
}

/** 個体の記録のうち、pid を決めるのに見る分 */
export interface IndividualLike {
  app: string;
  engine: string;
}

/** パスから作るアプリの id（登録簿にも無く、名前も付けられなかったとき） */
export function appIdFromPath(basePath: string): string {
  return `app_${basePath.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
}

/**
 * 何のアプリか。`basePath` は `?`・`#` を落としたパス、`requestedName` は起こすときに付けた名前（pid の指定）。
 * ホームのパスは、登録簿に無かったときだけ訊く。
 */
export function resolveApp(
  basePath: string,
  requestedName: string | undefined,
  registry: AppLookup,
  homePath: () => string,
): AppIdentity {
  const app = registry.getAllApps().find((a) => a.path === basePath);
  if (app) return { app: app.id, defaultType: 'app' };
  const service = registry.getAllServices().find((s) => s.path === basePath);
  if (service) return { app: service.id, defaultType: 'daemon' };
  if (basePath === homePath()) return { app: 'home', defaultType: 'app' };
  return { app: requestedName || appIdFromPath(basePath), defaultType: 'app' };
}

/** どの個体か。`processes` はいま動いている個体（pid → 記録） */
export function choosePid(
  requestedName: string | undefined,
  app: string,
  engine: string,
  processes: ReadonlyMap<string, IndividualLike>,
): string {
  if (requestedName) return requestedName;
  for (let n = 1; ; n++) {
    const candidate = n === 1 ? app : `${app}-${n}`;
    const holder = processes.get(candidate);
    if (!holder || (holder.app === app && holder.engine === engine)) return candidate;
  }
}
