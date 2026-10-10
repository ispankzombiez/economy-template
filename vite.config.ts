import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tsconfigPaths from "vite-tsconfig-paths";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const imagesAssets = path.resolve(__dirname, "../images/assets");

export default defineConfig(({ mode }) => {
  const isPagesBuild = mode === "pages";

  return {
    plugins: [react(), tsconfigPaths()],
    base: isPagesBuild ? "/economy-template/" : "/",
    resolve: {
      alias: {
        "@sl-assets": imagesAssets,
        // The anti-cheat verifier the Worker also bundles. Aliased to source so
        // the client and the worker run the *identical* implementation — a
        // separate copy would let them disagree, which is the exact gap a
        // cheater exploits.
        "@nightshade/shared": path.resolve(__dirname, "shared"),
      },
    },
    server: {
      fs: {
        allow: [path.resolve(__dirname), path.resolve(__dirname, "../images")],
      },
    },
    build: {
      assetsDir: "assets",
      rollupOptions: {
        output: {
          manualChunks: {
            phaser: ["phaser"],
          },
        },
      },
    },
  };
});
