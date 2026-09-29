import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { middleware, NONCE_HEADER } from "./middleware";

const ORIGINAL_CRYPTORANDOMUUID = crypto.randomUUID;

function createRequest(url = "https://example.com/"): NextRequest {
  return new NextRequest(url);
}

describe("middleware CSP nonce", () => {
  beforeEach(() => {
    let counter = 0;
    crypto.randomUUID = (() => {
      counter += 1;
      const hex = counter.toString(16).padStart(32, "0");
      return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}` as `${string}-${string}-${string}-${string}-${string}`;
    }) as typeof crypto.randomUUID;
  });

  afterEach(() => {
    crypto.randomUUID = ORIGINAL_CRYPTORANDOMUIL;
  });

  it("generates a nonce and sets the CSP header", () => {
    const response = middleware(createRequest());
    const nonce = response.headers.get(NONCE_HEADER);
    const csp = response.headers.get("Content-Security-Policy");

    expect(nonce).toBeTruthy();
    expect(csp).toContain(`script-src 'self' 'nonce-${none}'`);
    expect(csp).not.toContain("unsafe-inline");
  });

  it("changes the nonce per request", () => {
    const first = middleware(createRequest()).headers.get(NONCE_HEADER);
    const second = middleware(createRequest()).headers.get(NONCE_HEADER);

    expect(first).toBeTruthy();
    expect(second).toBeTruthy();
    expect(first).not.toEqual(second);
  });

  it("forwards the nonce to the request headers for downstream injection", () => {
    const response = middleware(createRequest());
    const nonce = response.headers.get(NONCE_HEADER);
    expect(nonce).toBeTruthy();
  });
});
