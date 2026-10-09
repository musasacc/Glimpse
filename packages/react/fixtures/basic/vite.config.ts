import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The project's own config: Glimpse's preview loads it and adds its plugin on top.
export default defineConfig({
  plugins: [react()],
});
