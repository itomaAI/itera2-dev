/**
 * src/config/attachment_policy.ts
 * 添付の門の方針 —— 配布物ごとに 1 か所で決める（門の実装 `core/chat/attachmentGate.ts` には書かない）。
 *
 * 利用者がチャットに添付したファイル（画面経路）と、アプリが `chat.append` の `attachments` で渡した
 * VFS のファイル（API 経路）は、同じ門（`decideAttachment`）を通る。門はこの方針で
 *   - どのファイルを「文字として本文に展開する」候補にするか（拡張子・MIME）
 *   - 展開するとき先頭の何行・何バイトまでにするか（残りは `read_file` で読ませる）
 *   - 何バイトを超えたら展開そのものをやめるか
 * を決める。展開は UTF-8 として読めるものだけ（方針ではなく門の規則）。
 *
 * ここは利用者に触らせない（ゲストの `system/config/` には出さない）。壊れると会話の入口が壊れる割に、
 * 調整したい値ではないため（T-0672 山内さん）。`wake_policy.ts` と同じ置き方で、ミャク楽とは値だけが違いうる。
 */
export interface InlineTextPolicy {
  /** 本文に展開する候補とみなす拡張子（小文字・ドット無し）。MIME が分からない／octet-stream のときの頼り */
  extensions: readonly string[];
  /** 本文に展開する候補とみなす MIME。`text/*` のように `/*` で前方一致、それ以外は完全一致 */
  mimes: readonly string[];
  /** 展開する行数の上限（`read_file` の既定と同じ 800）。これを超える分は `read_file` で読ませる */
  maxLines: number;
  /** 展開するバイト数の上限（UTF-8）。行数より先に当たればそこで切る */
  maxBytes: number;
  /** これを超える文字ファイルは 1 行も展開しない（置き場と大きさだけを伝える） */
  skipAboveBytes: number;
}

export interface AttachmentPolicy {
  inline: InlineTextPolicy;
}

export const ATTACHMENT_POLICY: AttachmentPolicy = {
  inline: {
    extensions: [
      'txt',
      'md',
      'js',
      'ts',
      'tsx',
      'json',
      'jsonl',
      'html',
      'css',
      'xml',
      'yml',
      'yaml',
      'toml',
      'ini',
      'csv',
      'tsv',
      'log',
      'sh',
      'py',
    ],
    mimes: [
      'text/*',
      'application/json',
      'application/xml',
      'application/x-yaml',
      'application/yaml',
      'application/toml',
      'application/javascript',
      'application/typescript',
      'application/x-sh',
      'application/x-ndjson',
    ],
    maxLines: 800,
    maxBytes: 64 * 1024,
    skipAboveBytes: 2 * 1024 * 1024,
  },
};
