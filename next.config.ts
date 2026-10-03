import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  redirects() {
    return [
      // 自動リサーチはトップページ（/）に移った。以前のブックマーク用
      { source: "/research", destination: "/", permanent: true },
    ];
  },
};

export default nextConfig;
