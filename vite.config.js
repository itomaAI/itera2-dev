import { defineConfig } from 'vite';

export default defineConfig({
  // アセットを相対パスで読み込むようにする設定
  base: './',
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
