import { NextResponse, type NextRequest } from 'next/server'
import {
  CSRF_COOKIE_NAME,
  CSRF_HEADER_NAME,
  generateToken,
  isMutatingMethod,
  serializeCsrfCookie,
  tokensMatch,
} from '@/lib/csrf'

/**
 * CSRF enforcement for the `/backend/*` rewrite (see next.config.mjs).
 *
 * That rewrite makes the backend same-origin as far as the browser is
 * concerned, so cookies ride along on every request with no CORS preflight —
 * exactly the precondition for CSRF. This gate runs before the rewrite and
 * rejects any state-changing `/backend/*` request that doesn't double-submit
 * the token from `lib/csrf.ts`.
 *
 * See docs/SECURITY_CSRF.md for the model and the reasoning.
 */

/** Only the proxied backend needs guarding; pages and assets are untouched. */
export const config = {
  matcher: '/backend/:path*',
}

/**
 * Rejects a forged state change. The reason travels in a response header for
 * debugging, while the body stays generic so nothing about the check leaks to
 * the page that triggered it.
 */
function reject(reason: string): NextResponse {
  return NextResponse.json(
    { error: 'CSRF validation failed. Reload the page and try again.', code: 'CSRF_FAILED' },
    { status: 403, headers: { 'X-CSRF-Reason': reason } }
  )
}

export function middleware(request: NextRequest): NextResponse {
  const cookie = request.cookies.get(CSRF_COOKIE_NAME)?.value
  const response = NextResponse.next()

  // Seed the token on the first request of a visit, so a page that submits
  // immediately — or a hard refresh — always has a token to submit.
  if (!cookie) {
    response.headers.append(
      'Set-Cookie',
      serializeCsrfCookie(generateToken(), request.nextUrl.protocol === 'https:')
    )
  }

  // Safe methods change nothing, so they pass through unchecked.
  if (!isMutatingMethod(request.method)) return response

  const provided = request.headers.get(CSRF_HEADER_NAME)
  if (!cookie) return reject('no-token')
  if (!provided) return reject('missing-header')
  if (!tokensMatch(cookie, provided)) return reject('mismatch')

  return response
}
