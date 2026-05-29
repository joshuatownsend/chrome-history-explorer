import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const API_PORT = process.env.API_PORT ?? "8787";

export default defineConfig({
  plugins: [react()],
  root: "src/web",
  publicDir: false,
  build: {
    outDir: "../../dist/web",
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      // Regex (not bare "/api") so it matches the API route prefix only — a bare
      // "/api" also catches the source module "/api.ts" and proxies it away,
      // which white-screens dev with a text/html MIME error.
      "^/api/": {
        target: `http://localhost:${API_PORT}`,
        changeOrigin: true,
      },
    },
  },
});
