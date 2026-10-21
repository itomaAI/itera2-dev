/**
 * src/core/chat/attachmentGate.ts
 * 添付の門（T-0672）。チャットに添付されたファイルを、履歴にどう置くかを 1 か所で決める。
 *
 *   'inline'    … 文字として本文（`<user_attachment>` の中）に展開する。先頭の N 行・M バイトまで。
 *                 残りは VFS の実体を `read` で読ませる
 *   'reference' … 文字ファイルだが展開しない（大きすぎる／UTF-8 でない）。置き場と理由だけを伝える
 *   'media'     … 画像など、方針の `media.directMimes` に当たるもの。`{media}` として投影に渡す（送れるかどうかは投影側の門が決める）
 *   'stored'    … それ以外（PDF・音声・動画・Office・zip …）。VFS に置いてパスと一言だけ伝える。読むならモデルが
 *                 `attach_file` / `pdf_tool` で（T-0690。既定では履歴に入れない）
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
  | { route: 'media'; mimeType: string; size: number }
  | { route: 'stored'; mimeType: string; size: number }
  | { route: 'inline'; clip: ClipResult }
  | { route: 'reference'; reason: ReferenceReason; size: number; totalLines: number | null };

const IMAGE_MIMES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
};
/** 音声・動画（attach_file が引く。旧 read_file が持っていた表をここに一本化した。T-0683） */
const AV_MIMES: Record<string, string> = {
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  mp4: 'video/mp4',
  webm: 'video/webm',
};
/** 文書・書庫（stored の注記と attach_file の型を揃えるため。モデルが受けるかは投影が決める。T-0690） */
const DOC_MIMES: Record<string, string> = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  doc: 'application/msword',
  xls: 'application/vnd.ms-excel',
  ppt: 'application/vnd.ms-powerpoint',
  zip: 'application/zip',
  gz: 'application/gzip',
  '7z': 'application/x-7z-compressed',
};

export function extensionOf(name: string): string {
  const base = name.split(/[\\/]/).pop() || '';
  const i = base.lastIndexOf('.');
  return i > 0 ? base.slice(i + 1).toLowerCase() : '';
}

/**
 * パスだけから決める MIME（API 経路。`File` が無いので拡張子で）。
 * 画像・音声・動画と PDF は正しい種別、文字の候補は text/plain、それ以外は octet-stream。
 */
export function mimeOfPath(path: string, policy: AttachmentPolicy = ATTACHMENT_POLICY): string {
  const ext = extensionOf(path);
  if (IMAGE_MIMES[ext]) return IMAGE_MIMES[ext];
  if (AV_MIMES[ext]) return AV_MIMES[ext];
  if (ext === 'pdf') return 'application/pdf';
  if (policy.inline.extensions.includes(ext)) return 'text/plain'; // svg も文字（XML）としてここに当たる
  if (DOC_MIMES[ext]) return DOC_MIMES[ext];
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

/** 履歴に media として置くか（方針の `media.directMimes` / `directExtensions` に当たり、`maxBytes` 以内） */
export function isDirectMedia(
  info: AttachmentInfo,
  mimeType: string,
  policy: AttachmentPolicy = ATTACHMENT_POLICY,
): boolean {
  const m = policy.media;
  const hit = mimeMatches(mimeType, m.directMimes) || m.directExtensions.includes(extensionOf(info.name));
  if (!hit) return false;
  return m.maxBytes === undefined || info.size <= m.maxBytes;
}

/** stored の注記に添える一言（方針の `media.hints`。MIME で引き、当たらなければ default） */
export function hintFor(mimeType: string, policy: AttachmentPolicy = ATTACHMENT_POLICY): string {
  const hints = policy.media.hints;
  for (const key of Object.keys(hints)) {
    if (key !== 'default' && mimeMatches(mimeType, [key])) return hints[key];
  }
  return hints.default || '';
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

/** 行数（末尾の改行は行に数えない。`read` の行番号と同じ数え方） */
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
    const mimeType = info.mimeType || mimeOfPath(info.name, policy);
    if (isDirectMedia(info, mimeType, policy)) return { route: 'media', mimeType, size: info.size };
    return { route: 'stored', mimeType, size: info.size };
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
    attrs.push(`bytes="${decision.size}"`);
    return `<user_attachment ${attrs.join(' ')}>[Binary File: ${file.name} (${decision.mimeType}, ${formatBytes(decision.size)})]</user_attachment>`;
  }
  if (decision.route === 'stored') {
    attrs.push(`bytes="${decision.size}"`);
    const hint = hintFor(decision.mimeType, policy);
    return `<user_attachment ${attrs.join(' ')}>[File saved to the VFS, not attached: ${decision.mimeType}, ${formatBytes(decision.size)}.${hint ? ' ' + hint : ''}]</user_attachment>`;
  }
  if (decision.route === 'reference') {
    if (decision.totalLines !== null) attrs.push(`lines="${decision.totalLines}"`);
    attrs.push(`bytes="${decision.size}"`, `truncated="true"`);
    const why =
      decision.reason === 'too_large'
        ? `${formatBytes(decision.size)} exceeds the inline limit of ${formatBytes(policy.inline.skipAboveBytes)}. Read it with <read> (start/end; it reads 800 lines at a time).`
        : decision.reason === 'binary'
          ? `its content looks binary (NUL bytes or a known file signature) despite the name. Inspect it from a script.`
          : decision.reason === 'not_utf8'
            ? `it is not valid UTF-8 (e.g. Shift_JIS). Convert it first, or read it as binary from a script.`
            : `its content could not be read. Use <read> on the path.`;
    return `<user_attachment ${attrs.join(' ')}>[Text file not expanded: ${why}]</user_attachment>`;
  }
  const { clip } = decision;
  attrs.push(`lines="${clip.totalLines}"`, `bytes="${clip.totalBytes}"`);
  if (!clip.truncated) return `<user_attachment ${attrs.join(' ')}>\n${clip.text}\n</user_attachment>`;
  attrs.push(`shown="1-${clip.shownLines}"`, `truncated="true"`);
  const what = clip.partialLine
    ? `the first ${formatBytes(policy.inline.maxBytes)} of line 1 (the line is ${formatBytes(clip.totalBytes)})`
    : `lines 1-${clip.shownLines} of ${clip.totalLines} (${formatBytes(policy.inline.maxBytes)} of ${formatBytes(clip.totalBytes)})`;
  const next = clip.partialLine ? '' : ` Read the rest with <read start="${clip.shownLines + 1}">.`;
  return `<user_attachment ${attrs.join(' ')}>\n${clip.text}\n[Truncated: showing ${what}.${next}]\n</user_attachment>`;
}
