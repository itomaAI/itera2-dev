/**
 * src/api/fileDataUrl.ts
 * VFS のファイルを data URL にする（`MetaOS.fs.read(path, { encoding: 'dataurl' })`）。
 *
 * 実体（ContentStore の Blob）は種別を持たない。そのまま FileReader に渡すと、どのファイルも
 * `data:application/octet-stream;base64,…` になる（T-0906）。種別は、ゲストに渡すほかの口
 * （`MetaOS.fs.resolveUrl`・アプリの資産）と同じ表（拡張子。{@link guestMimeOf}）から付ける。
 */
import { guestMimeOf, typedBlob } from '../shell/windowing/GuestCompiler';
import { blobToDataUrl } from '../utils/binary';

export function fileDataUrl(blob: Blob, path: string): Promise<string> {
  return blobToDataUrl(typedBlob(blob, guestMimeOf(path)));
}
