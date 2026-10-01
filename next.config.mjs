import withPWAInit from 'next-pwa'
import defaultRuntimeCaching from 'next-pwa/cache.js'
import { withSentryConfig } from '@sentry/nextjs'
import withBundleAnalyzer from '@next/bundle-analyzer'

/**
 * Validates that NEXT_API_URL is a safe absolute HTTP(S) URL.
 * Prevents SSRF attacks if the value is ever user-controlled or misconfigured.
 */
function validateBackendUrl(url) {
  try {
    const parsed = new URL(url)
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      throw new Error(`Invalid protocol: ${parsed.protocol} (must be http: or https:)`)
    }
    if (!parsed.hostname) {
      throw new Error('URL must include a hostname')
    }
  } catch (err) {
    console.error(
      `[FATAL] Invalid NEXT_API_URL: ${url}\n` +
      `${err instanceof Error ? err.message : String(err)}\n` +
      `Expected format: http://hostname:port or https://hostname\n` +
      `Examples: http://127.0.0.1:3000, https://api.example.com`
    )
    process.exit(1)
  }
}

/** @type {import('next').NextConfig} */
const nextConfig = {
  // PWA configuration (next-pwa v2 reads options from the `pwa` key)
  pwa: {
    dest: 'public',
    register: true,
    // skipWaiting: false — do NOT force immediate service worker updates.
    // A waiting SW activates only after the user dismisses the update banner
    // (see components/pwa-update-banner.tsx), preventing in-flight payment
    // flows from being interrupted.
    skipWaiting: false,
    disable: process.env.NODE_ENV === 'development',
  },
  experimental: {
    // Limit concurrency only in resource-constrained CI environments.
    // Set CI_LOW_RESOURCES=1 in your CI pipeline to enable these caps;
    // leave it unset for normal development and production builds so they
    // use all available CPU cores.
    ...(process.env.CI_LOW_RESOURCES
      ? {
          cpus: 1,
          staticGenerationMaxConcurrency: 1,
          staticGenerationMinPagesPerWorker: 1,
        }
      : {}),
  },
  images: {
    unoptimized: false,
    formats: ['image/avif', 'image/webp'],
    minimumCacheTTL: 60,
  },
  output: 'standalone',
  // The browser only ever calls this app's own origin at `/backend/*`; this
  // forwards those requests server-side to the real backend. NEXT_API_URL
  // (deliberately not NEXT_PUBLIC_*) never reaches client-side code — it
  // can't leak via devtools, a bundle diff, or CSP `connect-src`.
  // See docs/adr-001-backend-proxy.md for the rationale and consequences.
  rewrites() {
    const backendUrl = (process.env.NEXT_API_URL ?? 'http://127.0.0.1:3000').replace(/\/$/, '')
    validateBackendUrl(backendUrl)
    return [
      {
        source: '/backend/:path*',
        destination: `${backendUrl}/:path*`,
      },
    ]
  },
  headers() {
    const csp = [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob: https:",
      "font-src 'self' data:",
      "connect-src 'self' https://api.coingecko.com https://horizon.stellar.org https://horizon-testnet.stellar.org https://*.sentry.io https://*.ingest.us.sentry.io https://vitals.vercel-insights.com",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join('; ')

    return [
      {
        source: '/(.*)',
        headers: [
          { key: 'Content-Security-Policy', value: csp },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-XSS-Protection', value: '1; mode=block' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'camera=(self), microphone=(), geolocation=()' },
        ],
      },
    ]
  },
}

// next-pwa@5.6.0 is incompatible with Next.js 15's webpack runtime and causes
// "a[d] is not a function" errors during SSR prerendering in production builds.
// Disable it until the project upgrades to @ducanh2912/next-pwa or similar.
const withPWA = withPWAInit({
  dest: 'public',
  register: true,
  skipWaiting: true,
  reloadOnOnline: false,
  disable: true, // was: process.env.NODE_ENV === 'development'
  runtimeCaching: [
    {
      urlPattern: /\/api\/(?:exchange-rate|rates)(?:\/)?(?:\?.*)?$/,
      handler: 'StaleWhileRevalidate',
      method: 'GET',
      options: {
        cacheName: 'exchange-rates',
        cacheableResponse: {
          statuses: [0, 200],
        },
        expiration: {
          maxEntries: 8,
          maxAgeSeconds: 24 * 60 * 60,
          purgeOnQuotaError: true,
        },
      },
    },
    ...defaultRuntimeCaching,
  ],
})

const configWithPWA = withPWA(nextConfig)
const withAnalyzer = withBundleAnalyzer({
  enabled: process.env.ANALYZE === 'true',
  openAnalyzer: false,
})

export default withSentryConfig(withAnalyzer(configWithPWA))
