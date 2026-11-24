/**
 * src/api/principal.ts
 * ゲストプロセスの要求に付ける Principal を決める（T-0617）。
 *
 * 主体は「何として」で、プロセスの個体（pid）からではなく、何のアプリか（プロセスの記録の app。
 * 決め方は shell/windowing/processIdentity.ts）から決める（T-0903）。同じアプリの個体は、いくつ起こしても同じ主体。
 * 個体の見分けが要る所（同期のエコー止め・vfs_events）は、主体ではなく変更の個体の印（origin）を見る。
 *
 * 既定は { type: 'app', id: アプリの id }。ACL の rules はこの型で評価される。
 *
 * ■ system 特権
 *   同期デーモン（他の端末で起きた変更をこの VFS に写す者）は、AI の領域（acl.json の agent-only）の
 *   中にも書けなければならない。利用者・アプリは読むだけの領域なので、'app' のままでは
 *   他の端末からの変更が権限エラーで飛ばされ、「上りは成功するが降りてこない」片方向になる
 *   （2026-10-06 / T-0617。T-0614 で agent/ に ACL が付いた直後に起きた）。
 *   system 特権の principal（{ type: 'system' }）は VfsAuth が ACL を素通しさせる。
 *
 * ■ 鍵（ミャク楽の HostApiRouter と同じ形 ＋ 3 つ目）
 *   1. 実行パスが system/ の下にあること（配布物のデーモンであること。利用者の置いた HTML では取れない）
 *   2. 登録簿（services.json）のそのアプリの項目に systemPrivilege: true があること
 *   3. その項目が、このプロセスのファイルを指していること（T-0903）。
 *      特権は「何のファイルか」で決まる。起こすときに特権のあるデーモンの名前を付けただけの別のファイル
 *      （system/temp/ は誰でも書ける）には与えない
 *   全部を満たしたときだけ system になる。欠ければ 'app' のまま。
 */

export interface Principal {
  type: 'app' | 'system';
  id: string;
}

export interface PrincipalDeps {
  processManager?: { processes: Map<string, any> } | null;
  appRegistry?: { getService(id: string): any | undefined } | null;
}

export function resolvePrincipal(sourcePid: string, deps: PrincipalDeps): Principal {
  const proc = deps.processManager?.processes.get(sourcePid);
  const path: string = typeof proc?.path === 'string' ? proc.path : '';
  const basePath = path.split(/[?#]/)[0];
  // 何のアプリか。記録が無い（プロセスが見つからない）ときは pid をそのまま使う
  const app: string = typeof proc?.app === 'string' && proc.app ? proc.app : sourcePid;

  const isSystemPath = basePath.startsWith('system/');
  const service = deps.appRegistry?.getService(app);
  const isPrivilegedService = !!service && service.systemPrivilege === true && service.path === basePath;

  if (isSystemPath && isPrivilegedService) {
    return { type: 'system', id: app };
  }
  return { type: 'app', id: app };
}
