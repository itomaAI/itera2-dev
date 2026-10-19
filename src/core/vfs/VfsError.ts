/**
 * src/core/vfs/VfsError.ts
 * VFS が「断る」ときに投げる例外（T-0677）。
 *
 * VFS が投げるものには 2 種類ある。
 *   - 拒否: 無い・ある・ディレクトリだ・権限が無い・容量が無い … 操作の契約上の答え。呼んだ側の入力で決まる
 *   - 故障: OPFS の読み書きに失敗した・索引が壊れている・provider の返事が矛盾している … 実装か環境の欠陥
 * 前者だけをこのクラスにする。受け取る側（ツール・ホスト API）は、これなら「正常な失敗」として扱い、
 * それ以外の例外だけを不具合として記録できる。
 * message は従来のまま（ゲストに見える文面は変えない）。code は Node の errno に寄せた短い名前。
 */

export type VfsErrorCode =
  | 'ENOENT' // 無い
  | 'EEXIST' // 既にある
  | 'EISDIR' // ファイルを期待したがディレクトリ
  | 'ENOTDIR' // ディレクトリを期待したがファイル
  | 'EACCES' // 権限が無い
  | 'EINVAL' // 操作として成り立たない（ルートを消す・ゴミ箱の外を restore する など）
  | 'ENOSPC' // 容量が無い
  | 'ESTUB'; // 実体が無く、取ってくることもできなかった

export class VfsError extends Error {
  readonly code: VfsErrorCode;

  constructor(code: VfsErrorCode, message: string) {
    super(message);
    this.name = 'VfsError';
    this.code = code;
  }
}

/** instanceof は realm や束ね方で外れることがあるので、name でも見る */
export function isVfsError(err: unknown): err is VfsError {
  return err instanceof VfsError || (typeof err === 'object' && err !== null && (err as Error).name === 'VfsError');
}
