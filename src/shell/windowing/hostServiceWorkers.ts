/**
 * src/shell/windowing/hostServiceWorkers.ts
 * ホストの範囲に登録された Service Worker を解除する（T-0838）。
 *
 * ホストは Service Worker を使わない。だから、ホストの範囲（ホストの文書のあるディレクトリ以下）に登録が在れば、
 * それはゲストが境界を外している間に置いたものである。残すと、境界を戻した後もホストの読み込みを横取りできる。
 * 同じオリジンの別の場所（GitHub Pages では同じ持ち主の別のリポジトリ）の登録には触らない。
 */
export interface ServiceWorkerRegistrationLike {
  scope: string;
  unregister(): Promise<boolean>;
}

export interface ServiceWorkerContainerLike {
  getRegistrations(): Promise<readonly ServiceWorkerRegistrationLike[]>;
}

/** 解除した登録の scope を返す。Service Worker の無いブラウザでは何もしない */
export async function unregisterHostServiceWorkers(
  hostUrl: string,
  container: ServiceWorkerContainerLike | undefined = (globalThis.navigator as any)?.serviceWorker,
): Promise<string[]> {
  if (!container || typeof container.getRegistrations !== 'function') return [];
  const base = new URL('./', hostUrl).href;
  const done: string[] = [];
  for (const reg of await container.getRegistrations()) {
    if (!reg.scope.startsWith(base)) continue;
    try {
      if (await reg.unregister()) done.push(reg.scope);
    } catch (e) {
      console.warn('[hostServiceWorkers] unregister failed', reg.scope, e);
    }
  }
  return done;
}
