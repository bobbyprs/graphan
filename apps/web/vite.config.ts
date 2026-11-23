import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, path.resolve(__dirname, '../..'), 'VITE_');
  const apiTarget = env.VITE_API_URL || 'http://localhost:4000';
  return {
    plugins: [react()],
    envDir: path.resolve(__dirname, '../..'),
    resolve: { alias: { '@': path.resolve(__dirname, 'src') } },
    server: {
      port: 5173,
      proxy: {
        '/api': {
          target: apiTarget,
          changeOrigin: true,
          // Propagate browser aborts (Query Tool "Cancel") so the API can cancel the running DB query
          configure: (proxy) =>
            proxy.on('proxyReq', (proxyReq, _req, res) => {
              res.on('close', () => {
                if (!res.writableFinished) proxyReq.destroy();
              });
            }),
        },
        '/ws': { target: apiTarget, ws: true, changeOrigin: true },
      },
    },
    build: {
      sourcemap: true,
      chunkSizeWarningLimit: 2500,
      rollupOptions: {
        output: {
          manualChunks: {
            react: ['react', 'react-dom', 'react-router-dom'],
            mui: ['@mui/material', '@mui/icons-material', '@emotion/react', '@emotion/styled'],
            echarts: ['echarts', 'echarts-for-react'],
            aggrid: ['ag-grid-community', 'ag-grid-react'],
            monaco: ['monaco-editor/esm/vs/editor/editor.api', '@monaco-editor/react'],
          },
        },
      },
    },
  };
});
