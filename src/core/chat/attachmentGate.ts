/**
 * src/core/chat/attachmentGate.ts
 * 添付の門（T-0672）。チャットに添付されたファイルを、履歴にどう置くかを 1 か所で決める。
 *
 *   'inline'    … 文字として本文（`<user_attachment>` の中）に展開する。先頭の N 行・M バイトまで。
 *                 残りは VFS の実体を `read_file` で読ませる
 *   'reference' … 文字ファイルだが展開しない（大きすぎる／UTF-8 でない）。置き場と理由だけを伝える
 *   'media'     … 画像・PDF など。`{media}` として投影に渡す（送れるかどうかは投影側の門が決める）
 *
 * 画面経路（`EventOrchestrator._handleChatSend`）と API 経路（`chat.append` の `attachments`）の両方が
 * ここを呼ぶ。判定を 2 か所に置かない。数字と拡張子の列は `config/attachment_policy.ts`（配布物ごと）。
 * 副作用は無い（VFS もファイルも触らない。中身は呼び手が bytes で渡す）。
 */
import { ATTACHMENT_POLICY, type AttachmentPolicy, type InlineTextPolicy } from '../../config/attachment_policy';
import { isProbablyText, TEXT_SNIFF_BYTES } from '../sys/textDetect';

export interface AttachmentInfo {
  /** 元のファイル名（拡張子の判定に使う。パスでもよい） */
  name: string;
  /** ブラウザが付けた MIME。無ければ空か undefined */
  mimeType?: string;
  /** 実体の大きさ（バイト） */
  size: number;
}

export interface ClipResult {
  /** 展開する本文（切ったあと） */
  text: string;
  totalLines: number;
  totalBytes: number;
  /** 展開した行数（`partialLine` のときは 1） */
  shownLines: number;
  truncated: boolean;
  /** 1 行目だけでバイトの上限を超えたので、その行の途中で切った */
  partialLine: boolean;
}

export type ReferenceReason = 'too_large' | 'binary' | 'not_utf8' | 'unreadable';

export type AttachmentDecision =
  | { route: 'media'; mimeType: string }
  | { route: 'inline'; clip: ClipResult }
  | { route: 'reference'; reason: ReferenceReason; size: number; totalLines: number | null };

const IMAGE_MIMES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
};

export function extensionOf(name: string): string {
  const base = name.split(/[\\/]/).pop() || '';
  const i = base.lastIndexOf('.');
  return i > 0 ? base.slice(i + 1).toLowerCase() : '';
}

/**
 * パスだけから決める MIME（API 経路。`File` が無いので拡張子で）。
 * 画像と PDF は正しい種別、文字の候補は text/plain、それ以外は octet-stream。
 */
export function mimeOfPath(path: string, policy: AttachmentPolicy = ATTACHMENT_POLICY): string {
  const ext = extensionOf(path);
  if (IMAGE_MIMES[ext]) return IMAGE_MIMES[ext];
  if (ext === 'pdf') return 'application/pdf';
  if (policy.inline.extensions.includes(ext)) return 'text/plain';
  return 'application/octet-stream';
}

function mimeMatches(mime: string, patterns: readonly string[]): boolean {
  const base = mime.split(';')[0].trim().toLowerCase();
  if (!base) return false;
  for (const p of patterns) {
    if (p.endsWith('/*')) {
      if (base.startsWith(p.slice(0, -1))) return true;
    } else if (base === p.toLowerCase()) return true;
  }
  return false;
}

/** 文字として本文に展開する候補か（拡張子か MIME のどちらかが方針に当たる） */
export function isInlineCandidate(info: AttachmentInfo, policy: AttachmentPolicy = ATTACHMENT_POLICY): boolean {
  if (policy.inline.extensions.includes(extensionOf(info.name))) return true;
  return mimeMatches(info.mimeType || '', policy.inline.mimes);
}

/** UTF-8 として読めれば文字列、読めなければ null（BOM は落とす） */
export function decodeUtf8Strict(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    return null;
  }
}

/** 行数（末尾の改行は行に数えない。`read_file` の行番号と同じ数え方） */
export function countLines(text: string): number {
  if (text.length === 0) return 0;
  let n = 0;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
  return text.endsWith('\n') ? n : n + 1;
}

function countLinesInBytes(bytes: Uint8Array): number {
  if (bytes.length === 0) return 0;
  let n = 0;
  for (let i = 0; i < bytes.length; i++) if (bytes[i] === 10) n++;
  return bytes[bytes.length - 1] === 10 ? n : n + 1;
}

const encoder = new TextEncoder();

/** UTF-8 で `maxBytes` 以内に収まる先頭（文字の途中では切らない） */
function prefixWithinBytes(text: string, maxBytes: number): string {
  const encoded = encoder.encode(text);
  if (encoded.length <= maxBytes) return text;
  const decoded = new TextDecoder('utf-8').decode(encoded.subarray(0, maxBytes));
  return decoded.endsWith('\uFFFD') ? decoded.slice(0, -1) : decoded;
}

/**
 * 先頭の `maxLines` 行かつ `maxBytes` バイトまでに切る（早い方）。行の途中では切らない。
 * 1 行目だけで `maxBytes` を超えるときは、その行の先頭 `maxBytes` バイト分だけ（`partialLine`）。
 */
export function clipText(text: string, policy: InlineTextPolicy = ATTACHMENT_POLICY.inline): ClipResult {
  const totalLines = countLines(text);
  const totalBytes = encoder.encode(text).length;
  if (totalLines <= policy.maxLines && totalBytes <= policy.maxBytes) {
    return { text, totalLines, totalBytes, shownLines: totalLines, truncated: false, partialLine: false };
  }
  const lines = text.split('\n');
  const kept: string[] = [];
  let bytes = 0;
  for (let i = 0; i < lines.length && kept.length < policy.maxLines; i++) {
    const cost = encoder.encode(lines[i]).length + (kept.length > 0 ? 1 : 0);
    if (bytes + cost > policy.maxBytes) break;
    kept.push(lines[i]);
    bytes += cost;
  }
  if (kept.length === 0) {
    const head = prefixWithinBytes(lines[0], policy.maxBytes);
    return { text: head, totalLines, totalBytes, shownLines: 1, truncated: true, partialLine: true };
  }
  return {
    text: kept.join('\n'),
    totalLines,
    totalBytes,
    shownLines: kept.length,
    truncated: true,
    partialLine: false,
  };
}

/**
 * 添付 1 つをどう置くか決める。候補（文字）なら `bytes` が要る（無ければ 'unreadable' の reference）。
 * 候補でなければ bytes は見ない（画像を丸ごと読ませない）。
 */
export function decideAttachment(
  info: AttachmentInfo,
  bytes: Uint8Array | null,
  policy: AttachmentPolicy = ATTACHMENT_POLICY,
): AttachmentDecision {
  if (!isInlineCandidate(info, policy)) {
    return { route: 'media', mimeType: info.mimeType || mimeOfPath(info.name, policy) };
  }
  if (info.size > policy.inline.skipAboveBytes) {
    return {
      route: 'reference',
      reason: 'too_large',
      size: info.size,
      totalLines: bytes ? countLinesInBytes(bytes) : null,
    };
  }
  if (!bytes) return { route: 'reference', reason: 'unreadable', size: info.size, totalLines: null };
  // 名前は文字でも中身がバイナリ（xlsx を .csv と名付けたもの・NUL を含むログ）は展開しない。
  // 判定はエディタと同じ textDetect（判定を 2 か所に置かない）
  if (!isProbablyText(bytes.subarray(0, TEXT_SNIFF_BYTES))) {
    return { route: 'reference', reason: 'binary', size: info.size, totalLines: null };
  }
  const text = decodeUtf8Strict(bytes);
  if (text === null) {
    return { route: 'reference', reason: 'not_utf8', size: info.size, totalLines: countLinesInBytes(bytes) };
  }
  return { route: 'inline', clip: clipText(text, policy.inline) };
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * 履歴に置く `<user_attachment>` の文を組む。
 * 属性は name / path のほかに lines / bytes（文字のとき）、切ったときは shown / truncated。
 * 本文の中の注記は英語（モデルが読む。利用者に見える文も英語で統一している）。
 */
export function renderUserAttachmentNode(
  decision: AttachmentDecision,
  file: { name: string; path: string },
  policy: AttachmentPolicy = ATTACHMENT_POLICY,
): string {
  const attrs = [`name="${file.name}"`, `path="${file.path}"`];
  if (decision.route === 'media') {
    return `<user_attachment ${attrs.join(' ')}>[Binary File: ${file.name}]</user_attachment>`;
  }
  if (decision.route === 'reference') {
    if (decision.totalLines !== null) attrs.push(`lines="${decision.totalLines}"`);
    attrs.push(`bytes="${decision.size}"`, `truncated="true"`);
    const why =
      decision.reason === 'too_large'
        ? `${formatBytes(decision.size)} exceeds the inline limit of ${formatBytes(policy.inline.skipAboveBytes)}. Read it with read_file (start/end; it reads 800 lines at a time).`
        : decision.reason === 'binary'
          ? `its content looks binary (NUL bytes or a known file signature) despite the name. Inspect it from a script.`
          : decision.reason === 'not_utf8'
            ? `it is not valid UTF-8 (e.g. Shift_JIS). Convert it first, or read it as binary from a script.`
            : `its content could not be read. Use read_file on the path.`;
    return `<user_attachment ${attrs.join(' ')}>[Text file not expanded: ${why}]</user_attachment>`;
  }
  const { clip } = decision;
  attrs.push(`lines="${clip.totalLines}"`, `bytes="${clip.totalBytes}"`);
  if (!clip.truncated) return `<user_attachment ${attrs.join(' ')}>\n${clip.text}\n</user_attachment>`;
  attrs.push(`shown="1-${clip.shownLines}"`, `truncated="true"`);
  const what = clip.partialLine
    ? `the first ${formatBytes(policy.inline.maxBytes)} of line 1 (the line is ${formatBytes(clip.totalBytes)})`
    : `lines 1-${clip.shownLines} of ${clip.totalLines} (${formatBytes(policy.inline.maxBytes)} of ${formatBytes(clip.totalBytes)})`;
  const next = clip.partialLine ? '' : ` Read the rest with read_file (start="${clip.shownLines + 1}").`;
  return `<user_attachment ${attrs.join(' ')}>\n${clip.text}\n[Truncated: showing ${what}.${next}]\n</user_attachment>`;
}
