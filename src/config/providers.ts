// src/config/providers.ts
export const PROVIDERS = [
  {
    // 運営（この配布物のクラウド）が用意した LLM 中継。利用者は鍵を持たず、Itera Cloud のサインインで通る。
    // 選択肢の中身（実モデル）は運営が Firestore の台帳（llmModels）で決め、`GET /models` で受け取る。
    // 🔴 繋ぎ先（system/config/cloud.json の functionsBase）が無い配布物では一覧に出ない
    //    （CognitiveManager.getMergedProviders が外す）。itera2-dev はそれに当たる。T-0421
    id: 'itera',
    name: 'Itera Cloud',
    placeholder: '',
    requiresUrl: false,
    // 鍵を利用者が入力する対象ではない、という印。設定画面はこれを見て入力欄を出さない
    managed: true,
    defaultCapabilities: {
      maxMediaSizeMB: 100,
      supportedMimes: ['application/pdf', 'image/*', 'text/plain'],
    },
    // 選択肢はコードに書かない。取れないとき（起動直後・オフライン）は最後に取れた台帳を
    // localStorage の控えから出す（RelayCatalogCache）。控えも無ければ空
    models: [],
  },
  {
    id: 'google',
    name: 'Google (Gemini)',
    placeholder: 'AIzaSy...',
    requiresUrl: false,
    defaultCapabilities: {
      maxMediaSizeMB: 100,
      supportedMimes: ['application/pdf', 'image/*', 'video/*', 'audio/*'],
    },
    models: [],
  },
  {
    id: 'openai',
    name: 'OpenAI',
    placeholder: 'sk-proj-...',
    requiresUrl: false,
    defaultCapabilities: {
      maxMediaSizeMB: 50,
      supportedMimes: [
        'image/*',
        'application/pdf',
        'application/vnd.openxmlformats-officedocument.*',
        'text/*',
        'application/json',
      ],
    },
    models: [],
  },
  {
    id: 'anthropic',
    name: 'Anthropic',
    placeholder: 'sk-ant-...',
    requiresUrl: false,
    defaultCapabilities: {
      // 添付は本文に base64 で載せる（Files API はブラウザから使えない）。
      // 実効の上限は種別ごとに違う（画像 5MB / 文書 32MB。いずれも base64 後の大きさ）。
      // ここは緩い側を割り戻した値で、AnthropicProjector が種別ごとに絞り込む。
      maxMediaSizeMB: 24,
      supportedMimes: ['image/*', 'application/pdf', 'text/plain'],
    },
    models: [],
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    placeholder: 'sk-or-v1-...',
    requiresUrl: false,
    defaultCapabilities: {
      maxMediaSizeMB: 20,
      supportedMimes: ['image/*', 'application/pdf', 'text/*', 'application/json'],
    },
    models: [],
  },
  {
    id: 'custom',
    name: 'Local / Custom (OpenAI Compatible)',
    placeholder: 'API Key (Optional)',
    urlPlaceholder: 'http://localhost:11434/v1',
    requiresUrl: true,
    defaultCapabilities: {
      maxMediaSizeMB: 20,
      supportedMimes: ['image/*', 'application/pdf', 'text/*', 'application/json'],
    },
    models: [],
  },
];
