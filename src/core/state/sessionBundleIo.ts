/**
 * src/core/state/sessionBundleIo.ts
 * 会話を VFS のディレクトリとして出し入れする手順（T-0908。もとは SessionManager の中に在った）。
 *
 * 形は `<dir>/session.json`（`itera-session/1`。sessionArchive.ts）と `<dir>/media/`（添付）。
 * 同梱するのは `system/temp/` の下に在った添付だけで、VFS の別の場所への参照は参照のまま残す。
 * OS のチャットの会話（SessionManager）と、アプリが作ったエンジンの会話が、同じ手順・同じ形を使う ——
 * 違うのは添付の置き場（`mediaDir`）だけなので、どちらで保存した会話も、どちらでも開ける。
 *
 * 置き場（`system/temp/`）は OS の一時領域なので、そこを読むのも書くのも OS の主体。
 * 保存先を読むのも書くのも、頼んだ者の主体（`principal`）。
 */

import type { Turn } from './HistoryManager';
import type { Principal, VfsStat } from '../vfs/types';
import { SYSTEM_PRINCIPAL } from '../vfs/types';
import {
  EXPORT_MEDIA_DIR,
  EXPORT_SESSION_FILE,
  collectTempAttachmentPaths,
  parseSessionImport,
  relocateTempAttachments,
  type ParsedSessionImport,
} from './sessionArchive';

/** この手順が VFS に求める口（VfsService が満たす。試験は偽物を差す） */
export interface BundleVfs {
  exists(principal: Principal, path: string): boolean;
  stat(principal: Principal, path: string): VfsStat;
  listFiles(principal: Principal, options: { path: string; detail: true }): unknown;
  readFile(principal: Principal, path: string): Promise<string>;
  readBlob(principal: Principal, path: string): Promise<Blob>;
  writeFile(
    principal: Principal,
    path: string,
    content: string | Blob,
    options: { overwrite?: boolean; system?: boolean },
  ): Promise<unknown>;
}

/**
 * 同梱する添付を集める（名前 → いまのパス）: 会話の置き場の全ファイル ＋ 会話が参照する `system/temp/` の下のもの。
 * 名前が重なれば置き場のものが勝つ。置き場が無い会話は `mediaDir` に null。
 */
export function collectBundleMedia(vfs: BundleVfs, mediaDir: string | null, turns: Turn[]): Map<string, string> {
  const sources = new Map<string, string>();
  if (mediaDir && vfs.exists(SYSTEM_PRINCIPAL, mediaDir)) {
    for (const st of vfs.listFiles(SYSTEM_PRINCIPAL, { path: mediaDir, detail: true }) as VfsStat[]) {
      if (st.kind === 'file') sources.set(st.name, st.path);
    }
  }
  for (const p of collectTempAttachmentPaths(turns)) {
    const name = p.slice(p.lastIndexOf('/') + 1);
    if (!sources.has(name) && vfs.exists(SYSTEM_PRINCIPAL, p)) sources.set(name, p);
  }
  return sources;
}

/**
 * 添付を保存先の `media/` に写す。同じ中身（hash）が既に在れば飛ばす。戻り値は写した数。
 * 1 つ写せなくても残りは続ける（会話の本体は書けている）。
 */
export async function copyBundleMedia(
  vfs: BundleVfs,
  principal: Principal,
  sources: Map<string, string>,
  mediaDir: string,
): Promise<number> {
  let copied = 0;
  for (const [name, src] of sources) {
    const dest = `${mediaDir}/${name}`;
    try {
      if (vfs.exists(principal, dest)) {
        const a = vfs.stat(SYSTEM_PRINCIPAL, src);
        const b = vfs.stat(principal, dest);
        if (a.hash && b.hash && a.hash === b.hash) continue;
      }
      const blob = await vfs.readBlob(SYSTEM_PRINCIPAL, src);
      await vfs.writeFile(principal, dest, blob, { overwrite: true });
      copied++;
    } catch (e) {
      console.warn('[sessionBundleIo] Failed to bundle attachment', src, e);
    }
  }
  return copied;
}

export type ReadSessionBundleResult =
  | { ok: true; parsed: Extract<ParsedSessionImport, { ok: true }>; bundleDir: string | null }
  | { ok: false; detail: string };

/**
 * 保存された会話を読む。`path` は保存のディレクトリ・その中の `session.json`・旧形式の単一 `.json` のどれでもよい。
 * `bundleDir` は添付（`media/`）を探す場所（旧形式なら null）。読めない・形が違えば理由を返す。
 */
export async function readSessionBundle(
  vfs: BundleVfs,
  principal: Principal,
  path: string,
): Promise<ReadSessionBundleResult> {
  let sessionFile = path.replace(/\/+$/, '');
  let bundleDir: string | null = null;
  try {
    const st = vfs.stat(principal, sessionFile);
    if (st.kind === 'directory') {
      bundleDir = sessionFile;
      sessionFile = `${sessionFile}/${EXPORT_SESSION_FILE}`;
    } else if (sessionFile.endsWith(`/${EXPORT_SESSION_FILE}`)) {
      bundleDir = sessionFile.slice(0, -(EXPORT_SESSION_FILE.length + 1));
    }
  } catch (e) {
    return { ok: false, detail: (e as Error).message };
  }
  let text: string;
  try {
    text = await vfs.readFile(principal, sessionFile);
  } catch (e) {
    return { ok: false, detail: (e as Error).message };
  }
  const parsed = parseSessionImport(text);
  if (!parsed.ok) return { ok: false, detail: parsed.reason };
  return { ok: true, parsed, bundleDir };
}

/**
 * 同梱の添付（`<bundleDir>/media/`）を会話の置き場（`targetDir`）へ写し、会話の参照をそこへ向けたターンを返す。
 * 同梱が無ければターンはそのまま。
 * 🔴 写しは `readBlob` → `writeFile`（`copyFile` はスタブを取り寄せない）。
 */
export async function restoreBundleMedia(
  vfs: BundleVfs,
  principal: Principal,
  bundleDir: string | null,
  targetDir: string,
  turns: Turn[],
): Promise<Turn[]> {
  const mediaSrc = bundleDir ? `${bundleDir}/${EXPORT_MEDIA_DIR}` : null;
  if (!mediaSrc || !vfs.exists(principal, mediaSrc)) return turns;
  const available: string[] = [];
  for (const st of vfs.listFiles(principal, { path: mediaSrc, detail: true }) as VfsStat[]) {
    if (st.kind !== 'file') continue;
    try {
      const blob = await vfs.readBlob(principal, st.path);
      await vfs.writeFile(SYSTEM_PRINCIPAL, `${targetDir}/${st.name}`, blob, { overwrite: true, system: true });
      available.push(st.name);
    } catch (e) {
      console.warn('[sessionBundleIo] Failed to restore attachment', st.path, e);
    }
  }
  return relocateTempAttachments(turns, targetDir, available);
}
