import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

const withNextIntl = createNextIntlPlugin("./i18n/request.ts");

const projectRoot = path.dirname(fileURLToPath(import.meta.url));

const appVersion = JSON.parse(readFileSync(path.join(projectRoot, "package.json"), "utf8")).version as string;

const isDev = process.env.NODE_ENV === "development";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";

const cspDirectives = [
  "default-src 'self'",
  // No analytics hosts here on purpose. PostHog replaced Recapt and is
  // routed through the same-origin `/rl` rewrite below, so ingestion is
  // covered by `connect-src 'self'` and its lazy-loaded replay/survey
  // bundles by `script-src 'self'`. Adding `*.posthog.com` back would
  // re-widen the policy for no benefit and undo the ad-blocker resistance.
  `connect-src 'self' ${supabaseUrl} https://*.supabase.co https://*.enablebanking.com`,
  `style-src 'self' 'unsafe-inline' https://*.enablebanking.com`,
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""} https://*.enablebanking.com`,
  "img-src 'self' data: blob: https:",
  "font-src 'self'",
  "worker-src 'self' blob:",
  // object-src must explicitly allow blob:: Chrome's built-in PDF viewer
  // renders inline PDFs via an internal <embed>, which falls under
  // object-src. Without this, blob:-URL invoice previews (created via
  // URL.createObjectURL on /api/invoices/preview-pdf responses) show
  // "Det här innehållet har blockerats" in Chrome. Firefox uses PDF.js and
  // Edge uses its own viewer, so neither hits this. See crbug.com/271452.
  "object-src 'self' blob:",
  `frame-src 'self' blob: ${supabaseUrl}`,
  "frame-ancestors 'none'",
].join("; ");

const nextConfig: NextConfig = {
  output: 'standalone',
  // Build id inlined into the client bundle so a running tab can tell when a
  // newer deploy is live (see components/system/DeployReloadPrompt). On Vercel
  // this is the commit SHA; empty elsewhere (dev / self-hosted), which disables
  // the check. The /api/version route reads the same var at runtime to compare.
  env: {
    NEXT_PUBLIC_BUILD_ID: process.env.VERCEL_GIT_COMMIT_SHA ?? '',
    // Shown in the user menu. The version is the package.json field, bumped
    // in the release commit; the commit comes from the image build.
    NEXT_PUBLIC_APP_VERSION: appVersion,
    NEXT_PUBLIC_APP_COMMIT: process.env.APP_COMMIT ?? '',
  },
  // Multiple lockfiles exist above this project (e.g. a parent yarn.lock),
  // which makes Turbopack infer the wrong workspace root. Pin it explicitly.
  turbopack: {
    root: projectRoot,
  },
  skipTrailingSlashRedirect: true,
  experimental: {
    optimizePackageImports: ['recharts', 'date-fns', 'framer-motion'],
  },
  async redirects() {
    return [
      {
        source: '/nyckeltal',
        destination: '/kpi',
        permanent: true,
      },
    ]
  },
  async headers() {
    // The catch-all excludes /api/documents/:id/inline so the strict
    // X-Frame-Options: DENY + frame-ancestors 'none' don't conflict with
    // the embeddable override below: Next.js applies every matching
    // header rule, and duplicate X-Frame-Options/CSP values trigger
    // "Det här innehållet har blockerats" in Chromium browsers.
    return [
      {
        source: "/((?!api/documents/[^/]+/inline$).*)",
        headers: [
          {
            key: "Strict-Transport-Security",
            value: "max-age=86400",
          },
          {
            key: "X-Frame-Options",
            value: "DENY",
          },
          {
            key: "X-Content-Type-Options",
            value: "nosniff",
          },
          {
            key: "Referrer-Policy",
            value: "strict-origin-when-cross-origin",
          },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=(), payment=()",
          },
          {
            key: "Content-Security-Policy",
            value: cspDirectives,
          },
        ],
      },
      // Document inline-preview proxy must be embeddable in same-origin
      // iframes (used by the verifikat document preview Sheet). Excluded
      // from the catch-all above so these values aren't shadowed by the
      // stricter defaults.
      //
      // CSP is intentionally minimal: only `frame-ancestors 'self'`
      // prevents cross-origin clickjacking on the user's documents.
      // Adding `object-src 'none'` (or `default-src 'none'`) here breaks
      // Chrome's built-in PDF viewer: Chrome renders inline PDFs through
      // an internal <embed>, which the directive forbids, surfacing as
      // "Det här innehållet har blockerats" in the document preview Sheet.
      // Firefox uses PDF.js and Edge uses its own viewer, so neither hits
      // this. See crbug.com/271452. X-Content-Type-Options: nosniff plus
      // the explicit Content-Type from the route handler already prevent
      // MIME-confusion abuse.
      {
        source: "/api/documents/:id/inline",
        headers: [
          {
            key: "Strict-Transport-Security",
            value: "max-age=86400",
          },
          {
            key: "X-Frame-Options",
            value: "SAMEORIGIN",
          },
          {
            key: "X-Content-Type-Options",
            value: "nosniff",
          },
          {
            key: "Referrer-Policy",
            value: "strict-origin-when-cross-origin",
          },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=(), payment=()",
          },
          {
            key: "Content-Security-Policy",
            value: "frame-ancestors 'self'",
          },
        ],
      },
    ];
  },
};

export default withNextIntl(nextConfig);
