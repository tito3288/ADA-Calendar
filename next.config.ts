import type { NextConfig } from "next";
const config: NextConfig = {
  distDir: process.env.ADA_NEXT_DIST_DIR || ".next",
  output: "standalone",
  poweredByHeader: false,
  async headers() {
    return [{ source: "/(.*)", headers: [
      { key: "X-Content-Type-Options", value: "nosniff" },
      { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
      { key: "X-Frame-Options", value: "DENY" },
      { key: "Permissions-Policy", value: "camera=(), microphone=(self), geolocation=()" }
    ] }];
  }
};
export default config;
