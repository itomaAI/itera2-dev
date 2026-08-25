// src/config/providers.ts
export const PROVIDERS = [
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
      // 画像 1 枚の上限が 5MB で、履歴は毎ターン送り直すため、控えめに揃える。
      maxMediaSizeMB: 5,
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
