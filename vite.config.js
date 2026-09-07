import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // './' keeps asset paths relative, so the same build works at a domain root
  // (Netlify, Cloudflare Pages) and in a GitHub Pages subfolder.
  base: "./",
  build: { outDir: "dist" },
});
