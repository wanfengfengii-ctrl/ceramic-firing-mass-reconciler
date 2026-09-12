import { defineConfig } from "@playwright/test";

// 本地：config 直接 build 并启动 preview（preview 把 /api 代理到 API_PORT）。
// Docker verify 服务：API/WEB 已由 compose 起好，通过 BASE_URL 指定 nginx 源，
// 不再由 Playwright 启动服务器。
const manageServer = !process.env.BASE_URL;
const apiPort = process.env.API_PORT ?? "8000";

export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  fullyParallel: false,
  retries: 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: process.env.BASE_URL ?? "http://localhost:4173",
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
  webServer: manageServer
    ? {
        command: "npm run build && npm run preview -- --host --port 4173",
        port: 4173,
        timeout: 120_000,
        reuseExistingServer: true,
        env: {
          // preview 服务器需要知道 API 地址（vite preview 代理）
          API_PROXY_TARGET: `http://localhost:${apiPort}`,
        },
      }
    : undefined,
});
