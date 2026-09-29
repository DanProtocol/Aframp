/**
 * @jest-environment node
 */
import { NextRequest } from 'next/server'
import { CSRF_COOKIE_NAME, CSRF_HEADER_NAME } from '@/lib/csrf'
import { middleware } from '../middleware'

/**
 * Minimal `NextRequest` stand-in. Middleware only reads the method, the
 * `Cookie` header, the CSRF header, and `nextUrl.protocol`, so constructing
 * the real class buys nothing over a literal here.
 */
function request({
  method = 'GET',
  cookie,
  token,
  protocol = 'https:',
}: { method?: string; cookie?: string; token?: string; protocol?: string } = {}) {
  const headers = new Headers()
  if (cookie) headers.set('cookie', cookie)
  if (token) headers.set(CSRF_HEADER_NAME, token)

  return {
    method,
    headers,
    cookies: {
      get: (name: string) => {
        const match = cookie?.split(';').find((part) => part.trim().startsWith(`${name}=`))
        return match
          ? { value: decodeURIComponent(match.trim().slice(name.length + 1)) }
          : undefined
      },
    },
    nextUrl: { protocol },
  } as unknown as NextRequest
}

const VALID_COOKIE = `${CSRF_COOKIE_NAME}=token-abc`

describe('middleware', () => {
  describe('safe methods', () => {
    it('lets GET through without any token', () => {
      expect(middleware(request({ method: 'GET' })).status).toBe(200)
    })

    it('lets GET through even when a token cookie exists but no header is sent', () => {
      const response = middleware(request({ method: 'GET', cookie: VALID_COOKIE }))
      expect(response.status).toBe(200)
    })

    it('lets HEAD through', () => {
      expect(middleware(request({ method: 'HEAD', cookie: VALID_COOKIE })).status).toBe(200)
    })
  })

  describe('mutating methods', () => {
    it('allows POST when the header matches the cookie', () => {
      const response = middleware(
        request({ method: 'POST', cookie: VALID_COOKIE, token: 'token-abc' })
      )
      expect(response.status).toBe(200)
    })

    it('allows DELETE when the header matches the cookie', () => {
      const response = middleware(
        request({ method: 'DELETE', cookie: VALID_COOKIE, token: 'token-abc' })
      )
      expect(response.status).toBe(200)
    })

    it('rejects a forged POST that sends no token at all', () => {
      const response = middleware(request({ method: 'POST' }))
      expect(response.status).toBe(403)
      expect(response.headers.get('X-CSRF-Reason')).toBe('no-token')
    })

    it('rejects a POST with a cookie but no header — the cross-site form post case', () => {
      const response = middleware(request({ method: 'POST', cookie: VALID_COOKIE }))
      expect(response.status).toBe(403)
      expect(response.headers.get('X-CSRF-Reason')).toBe('missing-header')
    })

    it('rejects a POST whose header does not match the cookie', () => {
      const response = middleware(
        request({ method: 'POST', cookie: VALID_COOKIE, token: 'attacker-guess' })
      )
      expect(response.status).toBe(403)
      expect(response.headers.get('X-CSRF-Reason')).toBe('mismatch')
    })

    it('rejects a header that is a prefix of the real token', () => {
      const response = middleware(request({ method: 'POST', cookie: VALID_COOKIE, token: 'token' }))
      expect(response.status).toBe(403)
      expect(response.headers.get('X-CSRF-Reason')).toBe('mismatch')
    })

    it('rejects a DELETE with a mismatched token', () => {
      const response = middleware(
        request({ method: 'DELETE', cookie: VALID_COOKIE, token: 'nope' })
      )
      expect(response.status).toBe(403)
    })

    it('returns a generic error body with a machine-readable code', async () => {
      const response = middleware(request({ method: 'POST' }))
      await expect(response.json()).resolves.toEqual({
        error: 'CSRF validation failed. Reload the page and try again.',
        code: 'CSRF_FAILED',
      })
    })
  })

  describe('token cookie', () => {
    it('seeds a SameSite=Strict cookie when the request has none', () => {
      const setCookie = middleware(request({ method: 'GET' })).headers.get('Set-Cookie')
      expect(setCookie).toContain(`${CSRF_COOKIE_NAME}=`)
      expect(setCookie).toContain('SameSite=Strict')
    })

    it('adds Secure when the page is served over https', () => {
      expect(middleware(request({ protocol: 'https:' })).headers.get('Set-Cookie')).toContain(
        'Secure'
      )
    })

    it('omits Secure over plain http so local dev keeps working', () => {
      expect(middleware(request({ protocol: 'http:' })).headers.get('Set-Cookie')).not.toContain(
        'Secure'
      )
    })

    it('does not reissue a cookie the browser already has', () => {
      expect(
        middleware(request({ method: 'GET', cookie: VALID_COOKIE })).headers.get('Set-Cookie')
      ).toBeNull()
    })

    it('does not hand out a Set-Cookie on a request that was rejected', () => {
      expect(middleware(request({ method: 'POST' })).headers.get('Set-Cookie')).toBeNull()
    })
  })
})
