import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: "127.0.0.1",
    port: 18322,
    strictPort: true,
    proxy: {
      "/api": {
        target: process.env.ARC_API_TARGET || "http://192.168.31.201:18323",
        changeOrigin: false,
      },
      "/openapi.json": {
        target: process.env.ARC_API_TARGET || "http://192.168.31.201:18323",
        changeOrigin: false,
      },
    },
  },
  preview: { host: "127.0.0.1", port: 18322, strictPort: true },
});
