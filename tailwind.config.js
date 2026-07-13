/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  darkMode: 'class',
  theme: {
    extend: {
      fontFamily: {
        sans: ['var(--font-sans)', 'system-ui', '-apple-system', 'BlinkMacSystemFont', '"Segoe UI"', 'Roboto', '"Helvetica Neue"', 'Arial', '"Noto Sans JP"', '"Noto Sans"', '"Hiragino Kaku Gothic ProN"', '"Hiragino Sans"', 'Meiryo', 'sans-serif', '"Apple Color Emoji"', '"Segoe UI Emoji"', '"Segoe UI Symbol"', '"Noto Color Emoji"'],
        mono: ['var(--font-mono)', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'Monaco', 'Consolas', '"Liberation Mono"', '"Courier New"', 'monospace']
      },
      colors: {
        app: 'rgb(var(--c-bg-app) / <alpha-value>)',
        panel: 'rgb(var(--c-bg-panel) / <alpha-value>)',
        card: 'rgb(var(--c-bg-card) / <alpha-value>)',
        hover: 'rgb(var(--c-bg-hover) / <alpha-value>)',
        overlay: 'rgb(var(--c-bg-overlay) / <alpha-value>)',
        border: {
          main: 'rgb(var(--c-border-main) / <alpha-value>)',
          highlight: 'rgb(var(--c-border-highlight) / <alpha-value>)',
        },
        text: {
          main: 'rgb(var(--c-text-main) / <alpha-value>)',
          muted: 'rgb(var(--c-text-muted) / <alpha-value>)',
          inverted: 'rgb(var(--c-text-inverted) / <alpha-value>)',
          system: 'rgb(var(--c-text-system) / <alpha-value>)',
          'tag-attr': 'rgb(var(--c-text-tag-attr) / <alpha-value>)',
          'tag-content': 'rgb(var(--c-text-tag-content) / <alpha-value>)'
        },
        primary: 'rgb(var(--c-accent-primary) / <alpha-value>)',
        success: 'rgb(var(--c-accent-success) / <alpha-value>)',
        warning: 'rgb(var(--c-accent-warning) / <alpha-value>)',
        error: 'rgb(var(--c-accent-error) / <alpha-value>)',
        tag: {
          thinking: 'rgb(var(--c-tag-thinking) / <alpha-value>)',
          plan: 'rgb(var(--c-tag-plan) / <alpha-value>)',
          report: 'rgb(var(--c-tag-report) / <alpha-value>)',
          error: 'rgb(var(--c-tag-error) / <alpha-value>)',
        },
      },
      animation: {
        'fade-out': 'fadeOut 0.5s ease-out forwards',
      },
      keyframes: {
        fadeOut: { '0%': { opacity: '1' }, '100%': { opacity: '0', visibility: 'hidden' } }
      }
    }
  },
  plugins: [],
}