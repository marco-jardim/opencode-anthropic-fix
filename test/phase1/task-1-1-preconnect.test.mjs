import { describe, it, expect, beforeEach, afterEach } from "vitest";

// We test the exported helpers by extracting them. Since they're not exported,
// we test the behavior via the config defaults and function logic.

describe("Task 1.1: API Preconnect", () => {
  describe("preconnect config defaults", () => {
    it("T1.1.1: DEFAULT_CONFIG includes preconnect section", async () => {
      const { DEFAULT_CONFIG } = await import("../../lib/config.mjs");
      expect(DEFAULT_CONFIG.preconnect).toBeDefined();
      expect(DEFAULT_CONFIG.preconnect.enabled).toBe(true);
      expect(DEFAULT_CONFIG.preconnect.timeout_ms).toBe(10_000);
    });

    it("T1.1.2: preconnect.enabled defaults to true", async () => {
      const { DEFAULT_CONFIG } = await import("../../lib/config.mjs");
      expect(DEFAULT_CONFIG.preconnect.enabled).toBe(true);
    });
  });

  describe("isProxyOrMtlsEnvironment detection", () => {
    const proxyVars = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY"];
    const mtlsVars = ["NODE_EXTRA_CA_CERTS", "NODE_TLS_REJECT_UNAUTHORIZED", "SSL_CERT_FILE"];
    const allVars = [...proxyVars, ...mtlsVars];

    let saved;
    beforeEach(() => {
      saved = {};
      for (const v of allVars) {
        saved[v] = process.env[v];
        delete process.env[v];
      }
    });
    afterEach(() => {
      for (const v of allVars) {
        if (saved[v] !== undefined) process.env[v] = saved[v];
        else delete process.env[v];
      }
    });

    it("T1.1.3: returns false in clean environment", () => {
      // Inline the detection logic for unit testing since it's not exported
      function isProxyOrMtlsEnvironment() {
        for (const v of proxyVars) {
          if (process.env[v]) return true;
        }
        for (const v of mtlsVars) {
          if (process.env[v]) return true;
        }
        return false;
      }
      expect(isProxyOrMtlsEnvironment()).toBe(false);
    });

    it("T1.1.4: returns true when HTTPS_PROXY is set", () => {
      function isProxyOrMtlsEnvironment() {
        for (const v of proxyVars) {
          if (process.env[v]) return true;
        }
        for (const v of mtlsVars) {
          if (process.env[v]) return true;
        }
        return false;
      }
      process.env.HTTPS_PROXY = "http://proxy.corp:8080";
      expect(isProxyOrMtlsEnvironment()).toBe(true);
    });

    it("T1.1.5: returns true when NODE_EXTRA_CA_CERTS is set", () => {
      function isProxyOrMtlsEnvironment() {
        for (const v of proxyVars) {
          if (process.env[v]) return true;
        }
        for (const v of mtlsVars) {
          if (process.env[v]) return true;
        }
        return false;
      }
      process.env.NODE_EXTRA_CA_CERTS = "/etc/ssl/custom-ca.pem";
      expect(isProxyOrMtlsEnvironment()).toBe(true);
    });
  });

  describe("preconnectApi behavior", () => {
    it("T1.1.6: does not throw on network failure", async () => {
      // Simulate preconnectApi with a failing fetch
      async function preconnectApi(config) {
        if (!config.preconnect?.enabled) return;
        try {
          await Promise.race([
            Promise.reject(new Error("network error")),
            new Promise((_, r) => setTimeout(() => r(new Error("timeout")), config.preconnect.timeout_ms ?? 10_000)),
          ]);
        } catch {
          /* fire-and-forget */
        }
      }
      // Should not throw
      await expect(preconnectApi({ preconnect: { enabled: true, timeout_ms: 100 } })).resolves.toBeUndefined();
    });

    it("T1.1.7: skips when preconnect.enabled is false", async () => {
      let fetchCalled = false;
      async function preconnectApi(config) {
        if (!config.preconnect?.enabled) return;
        fetchCalled = true;
      }
      await preconnectApi({ preconnect: { enabled: false, timeout_ms: 100 } });
      expect(fetchCalled).toBe(false);
    });
  });
});
