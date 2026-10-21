import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vite";

// The API is the dev server in ../server (npm run serve); Vite proxies /api to it.
export default defineConfig({
  plugins: [vue()],
  server: { port: 5173, proxy: { "/api": { target: `http://localhost:${process.env.API_PORT ?? 8787}` } } },
});
