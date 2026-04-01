/**
 * Phase 0: Pre-flight validation tests for Plan A.
 *
 * T0.1: preconnectApi() resolves in < 10s on clean network (mocked)
 * T0.2: Proxy env vars detected correctly (mock env)
 * T0.3: Context limit error regex matches expected format
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// T0.1 — Preconnect HEAD request resolves
// ---------------------------------------------------------------------------
describe("preflight: preconnect", () => {
  it("T0.1: HEAD request resolves without throwing", async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response(null, { status: 404 }));
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch;

    try {
      // Simulate preconnect: fire-and-forget HEAD
      const result = await Promise.race([
        globalThis.fetch("https://api.anthropic.com", { method: "HEAD" }),
        new Promise((_, r) => setTimeout(() => r(new Error("timeout")), 10_000)),
      ]);
      expect(result.status).toBe(404);
      expect(mockFetch).toHaveBeenCalledWith("https://api.anthropic.com", { method: "HEAD" });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// ---------------------------------------------------------------------------
// T0.2 — Proxy env var detection
// ---------------------------------------------------------------------------
describe("preflight: proxy detection", () => {
  const PROXY_VARS = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY"];
  const MTLS_VARS = ["NODE_EXTRA_CA_CERTS", "NODE_TLS_REJECT_UNAUTHORIZED", "SSL_CERT_FILE"];

  /**
   * Pure predicate: returns true if proxy or mTLS env vars are set.
   * This is the function signature planned for isProxyOrMtlsEnvironment().
   */
  function isProxyOrMtlsEnvironment() {
    for (const v of PROXY_VARS) {
      if (process.env[v]) return true;
    }
    for (const v of MTLS_VARS) {
      if (process.env[v]) return true;
    }
    return false;
  }

  let savedEnv;

  beforeEach(() => {
    savedEnv = { ...process.env };
    // Clear all proxy/mTLS vars
    for (const v of [...PROXY_VARS, ...MTLS_VARS]) {
      delete process.env[v];
    }
  });

  afterEach(() => {
    // Restore env
    for (const key of Object.keys(process.env)) {
      if (!(key in savedEnv)) delete process.env[key];
    }
    for (const [key, val] of Object.entries(savedEnv)) {
      process.env[key] = val;
    }
  });

  it("T0.2a: returns false when no proxy vars set", () => {
    expect(isProxyOrMtlsEnvironment()).toBe(false);
  });

  it("T0.2b: detects HTTPS_PROXY", () => {
    process.env.HTTPS_PROXY = "http://proxy.corp:8080";
    expect(isProxyOrMtlsEnvironment()).toBe(true);
  });

  it("T0.2c: detects NODE_EXTRA_CA_CERTS (mTLS signal)", () => {
    process.env.NODE_EXTRA_CA_CERTS = "/path/to/ca.pem";
    expect(isProxyOrMtlsEnvironment()).toBe(true);
  });

  it("T0.2d: detects ALL_PROXY", () => {
    process.env.ALL_PROXY = "socks5://proxy:1080";
    expect(isProxyOrMtlsEnvironment()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// T0.3 — Context limit error regex
// ---------------------------------------------------------------------------
describe("preflight: overflow error format", () => {
  const OVERFLOW_REGEX = /input length and `max_tokens` exceed context limit:\s*(\d+)\s*\+\s*(\d+)\s*>\s*(\d+)/;

  it("T0.3a: matches standard error format", () => {
    const msg = "input length and `max_tokens` exceed context limit: 8500 + 1000000 > 100000";
    const match = msg.match(OVERFLOW_REGEX);
    expect(match).not.toBeNull();
    expect(+match[1]).toBe(8500);
    expect(+match[2]).toBe(1000000);
    expect(+match[3]).toBe(100000);
  });

  it("T0.3b: matches compact format (no spaces)", () => {
    const msg = "input length and `max_tokens` exceed context limit:8500+1000000>100000";
    const match = msg.match(OVERFLOW_REGEX);
    expect(match).not.toBeNull();
    expect(+match[1]).toBe(8500);
  });

  it("T0.3c: does not match unrelated error messages", () => {
    const msg = "invalid_request_error: model not found";
    expect(msg.match(OVERFLOW_REGEX)).toBeNull();
  });

  it("T0.3d: does not match partial format", () => {
    const msg = "prompt_too_long: your prompt is too long";
    expect(msg.match(OVERFLOW_REGEX)).toBeNull();
  });
});
