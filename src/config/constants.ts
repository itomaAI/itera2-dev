/**
 * src/config/constants.ts
 * Itera OS v2: System Constants
 */

export const PROVIDERS = [
  { id: "google", name: "Google (Gemini)", placeholder: "AIzaSy..." },
  { id: "openai", name: "OpenAI", placeholder: "sk-proj-..." },
  { id: "anthropic", name: "Anthropic", placeholder: "sk-ant-..." },
  { id: "openrouter", name: "OpenRouter", placeholder: "sk-or-v1-..." },
  {
    id: "custom",
    name: "Local / Custom (OpenAI Compatible)",
    requiresUrl: true,
    urlPlaceholder: "http://localhost:11434/v1",
    placeholder: "API Key (Optional)",
  },
];
