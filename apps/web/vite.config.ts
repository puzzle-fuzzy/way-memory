import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [vue(), tailwindcss()],
  server: {
    host: "0.0.0.0",
    port: 3412,
    proxy: {
      "/api": { target: "http://127.0.0.1:8787", changeOrigin: true },
      "/realtime": { target: "ws://127.0.0.1:8787", ws: true },
    },
  },
});
