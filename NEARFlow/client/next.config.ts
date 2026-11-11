import type { NextConfig } from "next";
const isDev = process.env.NODE_ENV !== "production";
const rpcOrigin = new URL(process.env.NEXT_PUBLIC_NEAR_RPC_URL || "https://rpc.testnet.near.org").origin;
const csp = [
  "default-src 'self'", "base-uri 'self'", "object-src 'none'", "frame-ancestors 'none'",
  "form-action 'self' https://testnet.mynearwallet.com", "img-src 'self' data: blob: https:",
  "font-src 'self' data: https://fonts.gstatic.com", "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""} https://s3.tradingview.com`,
  "frame-src 'self' https://s.tradingview.com https://www.tradingview.com",
  `connect-src 'self' ${rpcOrigin} https://helper.testnet.near.org https://api.binance.com https://*.tradingview.com wss://*.tradingview.com${isDev ? " ws://localhost:*" : ""}`,
  "worker-src 'self' blob:",
].join("; ");
const config: NextConfig = {
  output: "standalone", reactCompiler: true, poweredByHeader: false,
  turbopack: { root: __dirname },
  async headers() { return [{ source: "/:path*", headers: [
    { key: "Content-Security-Policy", value: csp },
    { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
    { key: "X-Content-Type-Options", value: "nosniff" },
    { key: "X-Frame-Options", value: "DENY" },
  ] }]; },
};
export default config;
