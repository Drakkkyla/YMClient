import { defineConfig } from "vite";

// Dual-stack bind: the default binds ::1 only (unreachable for Tauri's devUrl check here), and the
// page must be served as "localhost" — Yandex's stream CDN only grants CORS to localhost /
// tauri.localhost origins, never 127.0.0.1, so the analyser-enabled <audio> would fail to load.
export default defineConfig({
  root: "src",
  clearScreen: false,
  server: {
    port: 1430,
    strictPort: true,
    host: "::",
    watch: { ignored: ["**/src-tauri/**"] },
  },
  build: {
    outDir: "../dist",
    emptyOutDir: true,
    target: ["chrome105", "safari15"],
    minify: !process.env.TAURI_ENV_DEBUG ? "esbuild" : false,
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
  },
});
