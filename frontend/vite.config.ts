/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// 本地 dev / preview 时把 API 代理到 FastAPI；容器内由 nginx 统一反代。
const apiTarget = process.env.API_PROXY_TARGET ?? "http://localhost:8000";
const proxy = {
  "/api": apiTarget,
  "/healthz": apiTarget,
};

export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    port: 5173,
    proxy,
  },
  preview: {
    host: true,
    port: 4173,
    proxy,
  },
  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: ["./vitest.setup.ts"],
    css: false,
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
