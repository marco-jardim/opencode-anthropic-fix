import { describe, it, expect } from "vitest";
import { redactHeaders, redactSecrets, redactString } from "./redact.mjs";

describe("redactSecrets", () => {
  it("masks authorization without retaining token content", () => {
    const token = "sk-ant-oat01-XXXX";
    const input = { Authorization: `Bearer ${token}` };
    const result = redactHeaders(input);

    expect(result.Authorization).toMatch(/^Bearer \[redacted sha256:[0-9a-f]{12}\]$/);
    expect(result.Authorization).not.toContain(token);
    expect(input.Authorization).toBe(`Bearer ${token}`);
  });

  it("masks cookie and API key header values", () => {
    const result = redactHeaders({ "set-cookie": "session=secret", "x-api-key": "key-secret" });

    expect(result["set-cookie"]).toMatch(/^\[redacted sha256:[0-9a-f]{12}\]$/);
    expect(result["x-api-key"]).toMatch(/^\[redacted sha256:[0-9a-f]{12}\]$/);
    expect(result["set-cookie"]).not.toContain("session=secret");
    expect(result["x-api-key"]).not.toContain("key-secret");
  });

  it("masks nested account credentials", () => {
    const input = { account: { refreshToken: "refresh-secret", access: "access-secret" } };
    const result = redactSecrets(input);

    expect(result.account.refreshToken).toMatch(/^\[redacted sha256:[0-9a-f]{12}\]$/);
    expect(result.account.access).toMatch(/^\[redacted sha256:[0-9a-f]{12}\]$/);
    expect(result).not.toBe(input);
    expect(result.account).not.toBe(input.account);
  });

  it("leaves mimicry fingerprint headers byte-identical", () => {
    const input = {
      "anthropic-beta": "oauth-2025-04-20,prompt-caching-2024-07-31",
      "user-agent": "claude-cli/2.1.0 (external, cli)",
      "x-stainless-arch": "x64",
      "anthropic-version": "2023-06-01",
    };

    expect(redactHeaders(input)).toEqual(input);
  });

  it("leaves generic non-secret fields intact", () => {
    const input = {
      model: "claude-sonnet-4-5",
      temperature: 0.7,
      user: "alice",
      messages: [{ role: "user", content: "hi" }],
    };

    expect(redactSecrets(input)).toEqual(input);
  });

  it("masks an email local part and preserves its domain", () => {
    expect(redactSecrets({ email: "marco@example.com" })).toEqual({ email: "a***@example.com" });
  });

  it("is idempotent", () => {
    const input = {
      authorization: "Bearer secret-token",
      account: { refresh_token: "refresh-secret", email: "marco@example.com" },
    };
    const once = redactSecrets(input);

    expect(redactSecrets(once)).toEqual(once);
  });

  it("handles null, undefined, circular, and large objects without throwing", () => {
    const circular = { token: "secret" };
    circular.self = circular;
    const large = Object.fromEntries(Array.from({ length: 10_000 }, (_, index) => [`key${index}`, `value${index}`]));
    const redactedCircular = redactSecrets(circular);
    const redactedLarge = redactSecrets(large);

    expect(() => redactSecrets(null)).not.toThrow();
    expect(() => redactSecrets(undefined)).not.toThrow();
    expect(() => redactSecrets(circular)).not.toThrow();
    expect(() => redactSecrets(large)).not.toThrow();
    expect(redactedCircular.self).toBe(redactedCircular);
    expect(Object.keys(redactedLarge)).toHaveLength(10_000);
  });

  it("grep-proof: no known secret survives redactSecrets over a realistic header+body fixture", () => {
    const fakeSecrets = {
      bearer: "sk-ant-FAKEAUTH123.def-456",
      cookie: "session=FAKECOOKIE123",
      apiKey: "FAKEAPIKEY123",
      refreshToken: "FAKEREFRESH123",
      access: "FAKEACCESS123",
      code: "FAKECODE123",
      email: "fake.user@example.test",
      oauthToken: "oat01FAKEOAUTH12345",
    };
    const fixture = {
      headers: {
        authorization: `Bearer ${fakeSecrets.bearer}`,
        cookie: fakeSecrets.cookie,
        "x-api-key": fakeSecrets.apiKey,
        "x-stainless-lang": "js",
      },
      body: {
        account: {
          refreshToken: fakeSecrets.refreshToken,
          access: fakeSecrets.access,
          code: fakeSecrets.code,
          email: fakeSecrets.email,
        },
        callbackUrl: `https://auth.example.test/callback?token=${fakeSecrets.oauthToken}`,
      },
    };

    const serialized = JSON.stringify(redactSecrets(fixture));

    expect(serialized).not.toMatch(/Bearer\s+[A-Za-z0-9._-]{6,}/);
    expect(serialized).not.toMatch(/sk-ant-[A-Za-z0-9]{6,}/);
    expect(serialized).not.toMatch(/\boat01[A-Za-z0-9]{8,}/);
    for (const secret of Object.values(fakeSecrets)) {
      expect(serialized).not.toContain(secret);
    }
    expect(serialized).toContain('"x-stainless-lang":"js"');
  });
});

describe("redactString", () => {
  it("removes bearer token markers from body dumps", () => {
    const result = redactString("prefix Bearer sk-ant-oat01-abc.def suffix");

    expect(result).not.toContain("sk-ant");
    expect(result).not.toContain("oat01");
    expect(result).toMatch(/Bearer \[redacted sha256:[0-9a-f]{12}\]/);
  });

  it("redacts a bearer/sk-ant/oat01 token embedded mid-string in a URL", () => {
    const bearerCredential = "abc.def-123";
    const skAntToken = "sk-ant-abc123.def-456";
    const oauthToken = "oat01ABCDEFGH12345";
    const bearerResult = redactString(`https://api.example.com/cb?x=1#Authorization=Bearer%20${bearerCredential}`);
    const skAntResult = redactString(`prefix ${skAntToken} suffix`);
    const oauthResult = redactString(`https://auth.example.com/cb#token=...${oauthToken}...`);

    for (const [result, rawToken] of [
      [bearerResult, bearerCredential],
      [skAntResult, skAntToken],
      [oauthResult, oauthToken],
    ]) {
      expect(result).not.toContain(rawToken);
      expect(result).toMatch(/\[redacted sha256:[0-9a-f]{12}\]/);
    }
    expect(bearerResult).toContain("https://api.example.com/cb?x=1#Authorization=Bearer%20");
    expect(oauthResult).toContain("https://auth.example.com/cb#token=...");
  });
});
