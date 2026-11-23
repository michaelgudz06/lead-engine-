import type { NextConfig } from "next";

// Cache Components and partial prefetching are off on purpose: every page here
// shows live, per-lead data that changes while research runs, so nothing is
// worth prerendering, and the classic dynamic model keeps the code simple.
const nextConfig: NextConfig = {
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
