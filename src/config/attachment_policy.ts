/**
 * src/config/attachment_policy.ts
 * 添付の門の方針 —— 配布物ごとに 1 か所で決める（門の実装 `core/chat/attachmentGate.ts` には書かない）。
 *
 * 利用者がチャットに添付したファイル（画面経路）と、アプリが `chat.append` の `attachments` で渡した
 * VFS のファイル（API 経路）は、同じ門（`decideAttachment`）を通る。門はこの方針で
 *   - どのファイルを「文字として本文に展開する」候補にするか（拡張子・MIME）
 *   - 展開するとき先頭の何行・何バイトまでにするか（残りは `read` で読ませる）
 *   - 何バイトを超えたら展開そのものをやめるか
 *   - 文字でないもののうち、どれを履歴に media として置く（投影がモデルへ送る）か（`media`）。それ以外は VFS に置いて
 *     パスと一言だけ伝える（`stored`）。読むかどうか・どう読むかはモデルが決める（`attach_file` / `pdf_tool`）
 * を決める。展開は UTF-8 として読めるものだけ（方針ではなく門の規則）。
 *
 * media は履歴に残る限り毎ターン送り直される（投影は毎回 MIME と大きさを見る）。PDF を既定で media にしないのは
 * そのため（35 ページを 1 度貼ると以後のターン全部にその費用が乗る）と、OS 側で解析してから渡す方がよい PDF が多いため
 * （フォントを埋め込まない積算ソフトの出力は、モデル側の PDF 処理で名称が消える —— `pdf_text` なら読める。2026-10-21 T-0690）。
 *
 * ここは利用者に触らせない（ゲストの `system/config/` には出さない）。壊れると会話の入口が壊れる割に、
 * 調整したい値ではないため（T-0672 山内さん）。`wake_policy.ts` と同じ置き方で、ミャク楽とは値だけが違いうる。
 */
export interface InlineTextPolicy {
  /** 本文に展開する候補とみなす拡張子（小文字・ドット無し）。MIME が分からない／octet-stream のときの頼り */
  extensions: readonly string[];
  /** 本文に展開する候補とみなす MIME。`text/*` のように `/*` で前方一致、それ以外は完全一致 */
  mimes: readonly string[];
  /** 展開する行数の上限（`read` の既定と同じ 800）。これを超える分は `read` で読ませる */
  maxLines: number;
  /** 展開するバイト数の上限（UTF-8）。行数より先に当たればそこで切る */
  maxBytes: number;
  /** これを超える文字ファイルは 1 行も展開しない（置き場と大きさだけを伝える） */
  skipAboveBytes: number;
}

export interface MediaPolicy {
  /** 履歴に media として置く MIME。`image/*` のように `/*` で前方一致、それ以外は完全一致 */
  directMimes: readonly string[];
  /** MIME が分からない／octet-stream のときに media とみなす拡張子（小文字・ドット無し） */
  directExtensions: readonly string[];
  /** これを超えるものは media にせず stored。未指定なら大きさを見ない（投影側の上限 `maxMediaSizeMB` が効く） */
  maxBytes?: number;
  /**
   * stored の注記に添える一言（モデルが読む。英語）。鍵は MIME（`/*` の前方一致か完全一致）。当たらなければ `default`。
   * ここに置くのは「どう読めばよいか」であって、読むかどうかの判断ではない
   */
  hints: Readonly<Record<string, string>>;
}

export interface AttachmentPolicy {
  inline: InlineTextPolicy;
  media: MediaPolicy;
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
      'svg', // XML。画像ではなく文字として扱う（media の image/* に当てない。T-0690）
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
      'image/svg+xml',
    ],
    maxLines: 800,
    maxBytes: 64 * 1024,
    skipAboveBytes: 2 * 1024 * 1024,
  },
  media: {
    directMimes: ['image/*'],
    directExtensions: ['png', 'jpg', 'jpeg', 'gif', 'webp'],
    // 画像の大きさは見ない（モデル側で一定の解像度に落とされるので、容量とトークンは比例しない。2026-10-21 山内さん）。
    // 上限を置きたい配布物は数値を入れる
    maxBytes: undefined,
    hints: {
      'application/pdf':
        'To read it whole, use <attach_file> (a PDF keeps its text layer). For a large one, spawn system/services/pdf_tool.html and use pdf_info → pdf_extract → attach_file (or pdf_text for plain text).',
      'audio/*': 'To listen to it, use <attach_file> (if the model accepts audio).',
      'video/*': 'To watch it, use <attach_file> (if the model accepts video).',
      default: 'Inspect it from a script, or use <attach_file> if the model accepts this type.',
    },
  },
};
