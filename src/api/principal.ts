/**
 * src/api/principal.ts
 * ゲストプロセスの要求に付ける Principal を決める（T-0617）。
 *
 * 既定は { type: 'app', id: pid }。ACL の rules はこの型で評価される。
 *
 * ■ system 特権
 *   同期デーモン（他の端末で起きた変更をこの VFS に写す者）は、AI の領域（acl.json の agent-only）の
 *   中にも書けなければならない。利用者・アプリは読むだけの領域なので、'app' のままでは
 *   他の端末からの変更が権限エラーで飛ばされ、「上りは成功するが降りてこない」片方向になる
 *   （2026-10-06 / T-0617。T-0614 で agent/ に ACL が付いた直後に起きた）。
 *   system 特権の principal（{ type: 'system' }）は VfsAuth が ACL を素通しさせる。
 *
 * ■ 二重の鍵（ミャク楽の HostApiRouter と同じ形）
 *   1. 実行パスが system/ の下にあること（配布物のデーモンであること。利用者の置いた HTML では取れない）
 *   2. 登録簿（services.json）のその id に systemPrivilege: true があること
 *   両方を満たしたときだけ system になる。片方では 'app' のまま。
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
  const isSystemPath = path.startsWith('system/');

  const service = deps.appRegistry?.getService(sourcePid);
  const isPrivilegedService = !!service && service.systemPrivilege === true;

  if (isSystemPath && isPrivilegedService) {
    return { type: 'system', id: sourcePid };
  }
  return { type: 'app', id: sourcePid };
}
