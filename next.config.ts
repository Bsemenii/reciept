import type { NextConfig } from "next";

// The local backend (npm run server). Server-side only, the browser always calls same-origin /api.
const BACKEND_URL = process.env.BACKEND_URL ?? "http://localhost:8787";

const nextConfig: NextConfig = {
  cacheComponents: true,
  // Phones reach `next dev` through `cloudflared tunnel`; without this, dev assets/HMR are blocked
  allowedDevOrigins: ["*.trycloudflare.com"],
  rewrites: async () => [{ source: "/api/:path*", destination: `${BACKEND_URL}/api/:path*` }],
  partialPrefetching: true,
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
