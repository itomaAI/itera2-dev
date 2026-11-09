import { defineConfig } from 'vite';

export default defineConfig({
  // アセットを相対パスで読み込むようにする設定
  base: './',
  // vite preview（手元の試験）でも配信先（GitHub Pages）と同じく CORS を返す。opaque origin のゲストが /vendor を import() するため
  preview: { headers: { 'Access-Control-Allow-Origin': '*' } },
  build: {
    chunkSizeWarningLimit: 1000,
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            {
              name: 'vfs-defaults',
              test: /src[\\/]config[\\/]default_files/,
              priority: 20,
            },
          ],
        },
      },
    },
  },
});
