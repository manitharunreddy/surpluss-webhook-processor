import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Original Next.js configuration
  cacheComponents: true,
  partialPrefetching: true,
  reactCompiler: true,

  // Tailwind CSS integration
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },

  // Docker production build
  output: "standalone",

  // Backend API proxy
  async rewrites() {
    return [
      {
        source: "/api/:path*",
        destination: `${
          process.env.BACKEND_URL || "http://localhost:3001"
        }/:path*`,
      },
    ];
  },
};

export default nextConfig;
