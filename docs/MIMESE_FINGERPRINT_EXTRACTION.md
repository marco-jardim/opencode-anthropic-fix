# Mimese/Fingerprint Fidelity Analysis - Code Extraction

**Generated:** 2026-04-07 (updated 2026-04-14 for v2.1.107 changes)  
**File:** D:\git\opencode-anthropic-fix\index.mjs  
**Scope:** All functions related to HTTP header composition, system prompt building, metadata construction, and signature emulation for Claude Code mimicry.

> **v2.1.107 UPDATE:** The `cch` field in the billing header is no longer a static `"00000"` placeholder. Starting with v2.1.107, the compiled Bun binary computes `cch` dynamically via `xxHash64(serializedBody, 0x6E52736AC806831E) & 0xFFFFF` → 5-hex-char hash, replacing `"cch=00000"` in the serialized body bytes. The plugin now replicates this via `xxhash-wasm`. See `computeAndReplaceCCH()` below and §16 Enforcement Changelog for full details.
>
> **v2.1.107 UPDATE:** Anthropic now blocklists specific tool names in the request body. The name `todowrite` (opencode's all-lowercase version of CC's `TodoWrite`) triggers immediate 400 rejection. The plugin now renames blocklisted tool names to their CC equivalents.

---

## 1. FULL FUNCTION EXTRACTS

### 1.1 getSdkVersion() — Lines 4963-4965

```javascript
function getSdkVersion(cliVersion) {
  return CLI_TO_SDK_VERSION.get(cliVersion) ?? ANTHROPIC_SDK_VERSION;
}
```

**Purpose:** Maps Claude Code version to Anthropic SDK version for `x-stainless-package-version` header. Uses `CLI_TO_SDK_VERSION` mapping or falls back to `ANTHROPIC_SDK_VERSION` constant.

---

### 1.2 computeBillingCacheHash() — Lines 4966-4980

```javascript
const BILLING_HASH_SALT = "59cf53e54c78";
const BILLING_HASH_INDICES = [4, 7, 20];

/**
 * Compute the billing cache hash (cch) matching Claude Code's NP1() function.
 * SHA256(salt + chars_at_indices[4,7,20]_from_first_user_msg + version).slice(0,3)
 * @param {string} firstUserMessage
 * @param {string} version
 * @returns {string}
 */
function computeBillingCacheHash(firstUserMessage, version) {
  const chars = BILLING_HASH_INDICES.map((i) => firstUserMessage[i] || "0").join("");
  const input = `${BILLING_HASH_SALT}${chars}${version}`;
  return createHashCrypto("sha256").update(input).digest("hex").slice(0, 3);
}
```

**Purpose:** Computes the 3-character fingerprint hash appended to `cc_version` in the billing header. Matches real Claude Code's `computeFingerprint()` from `utils/fingerprint.ts`. Uses characters at indices 4, 7, 20 from first user message.

**Key Constants:**

- Salt: `59cf53e54c78`
- Hash indices: `[4, 7, 20]`
- Output: First 3 hex chars of SHA256

---

### 1.3 buildExtendedUserAgent() — Lines 5328-5335

```javascript
function buildExtendedUserAgent(version) {
  const entrypoint = process.env.CLAUDE_CODE_ENTRYPOINT ?? "cli";
  const sdkVersion = process.env.CLAUDE_AGENT_SDK_VERSION ? `, agent-sdk/${process.env.CLAUDE_AGENT_SDK_VERSION}` : "";
  const clientApp = process.env.CLAUDE_AGENT_SDK_CLIENT_APP
    ? `, client-app/${process.env.CLAUDE_AGENT_SDK_CLIENT_APP}`
    : "";
  return `claude-cli/${version} (external, ${entrypoint}${sdkVersion}${clientApp})`;
}
```

**Purpose:** Constructs the `user-agent` header value. Format matches real Claude Code's client.ts implementation.

**Format:** `claude-cli/{version} (external, {entrypoint}[, agent-sdk/{version}][, client-app/{app}])`

**Environment Variables:**

- `CLAUDE_CODE_ENTRYPOINT` → entrypoint (default: "cli")
- `CLAUDE_AGENT_SDK_VERSION` → optional agent-sdk suffix
- `CLAUDE_AGENT_SDK_CLIENT_APP` → optional client-app suffix

---

### 1.4 buildStainlessHelperHeader() — Lines 5523-5546

```javascript
function buildStainlessHelperHeader(tools, messages) {
  const helpers = new Set();

  const collect = (value) => {
    if (!value || typeof value !== "object") return;

    for (const key of STAINLESS_HELPER_KEYS) {
      if (typeof value[key] === "string" && value[key]) {
        helpers.add(value[key]);
      }
    }

    if (Array.isArray(value.content)) {
      for (const contentBlock of value.content) {
        collect(contentBlock);
      }
    }
  };

  for (const tool of tools) collect(tool);
  for (const message of messages) collect(message);

  return Array.from(helpers).join(", ");
}
```

**Purpose:** Extracts and deduplicates Stainless helper identifiers from tools and messages. Scans for keys: `x_stainless_helper`, `x-stainless-helper`, `stainless_helper`, `stainlessHelper`, `_stainless_helper`.

**Output:** Comma-separated string of unique helpers (or empty string if none found).

---

### 1.5 buildRequestMetadata() — Lines 5569-5595

```javascript
/**
 * @param {{persistentUserId: string, accountId: string, sessionId: string}} input
 * @returns {{user_id: string}}
 */
function buildRequestMetadata(input) {
  // Backward-compat override: raw user_id passed through without JSON-encoding.
  const envUserId = process.env.OPENCODE_ANTHROPIC_SIGNATURE_USER_ID?.trim();
  if (envUserId) return { user_id: envUserId };

  const extraMetadataEnv = process.env.CLAUDE_CODE_EXTRA_METADATA?.trim();
  let extraMetadata = {};
  if (extraMetadataEnv) {
    try {
      const parsed = JSON.parse(extraMetadataEnv);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        extraMetadata = parsed;
      }
    } catch {
      /* ignore */
    }
  }

  return {
    user_id: JSON.stringify({
      ...extraMetadata,
      device_id: input.persistentUserId,
      account_uuid: input.accountId,
      session_id: input.sessionId,
    }),
  };
}
```

**Purpose:** Constructs the `metadata.user_id` JSON object for API requests. Format matches real Claude Code's metadata injection.

**JSON Structure:**

```json
{
  "device_id": "<persistentUserId>",
  "account_uuid": "<accountId>",
  "session_id": "<sessionId>"
}
```

**Environment Overrides:**

- `OPENCODE_ANTHROPIC_SIGNATURE_USER_ID` → Raw string override (no JSON encoding)
- `CLAUDE_CODE_EXTRA_METADATA` → Additional fields to merge

---

### 1.6 buildAnthropicBillingHeader() — Lines 5610-5634

```javascript
/**
 * Build the billing header block for Claude Code system prompt injection.
 * Claude Code v2.1.92: cc_version includes 3-char fingerprint hash (not model ID).
 * cch is a static "00000" placeholder for Bun native client attestation.
 *
 * Real CC (system.ts:78): version = `${MACRO.VERSION}.${fingerprint}`
 * Real CC (system.ts:82): cch = feature('NATIVE_CLIENT_ATTESTATION') ? ' cch=00000;' : ''
 *
 * @param {string} version - CLI version (e.g., "2.1.92")
 * @param {string} [firstUserMessage] - First user message text for fingerprint computation
 * @param {string} [provider] - API provider ("anthropic" | "bedrock" | "vertex" | "foundry")
 * @returns {string}
 */
function buildAnthropicBillingHeader(version, firstUserMessage, provider) {
  if (isFalsyEnv(process.env.CLAUDE_CODE_ATTRIBUTION_HEADER)) return "";
  const entrypoint = process.env.CLAUDE_CODE_ENTRYPOINT || "unknown";
  // Fix #1: cc_version suffix is the 3-char fingerprint hash, NOT the model ID.
  // computeBillingCacheHash() computes SHA256(salt + msg[4]+msg[7]+msg[20] + version)[:3]
  // which matches computeFingerprint() in the real CC source (utils/fingerprint.ts).
  // Always call the hash function — even for empty messages the real CC computes
  // the hash from "000" chars (indices 4,7,20 all missing → fallback "0").
  const fingerprint = computeBillingCacheHash(firstUserMessage || "", version);
  const ccVersion = `${version}.${fingerprint}`;
  // Fix #4: cch is a static "00000" placeholder for Bun's native client attestation.
  // Real CC v92: cch is included for all providers EXCEPT bedrock/anthropicAws.
  // The real Bun binary overwrites these zeros in the serialized body bytes.
  // For non-Bun runtimes, the server sees "00000" and skips attestation verification.
  const isBedrock = provider === "bedrock" || provider === "anthropicAws";
  const cchPart = isBedrock ? "" : " cch=00000;";
  let header = `x-anthropic-billing-header: cc_version=${ccVersion}; cc_entrypoint=${entrypoint};${cchPart}`;
  const workload = process.env.CLAUDE_CODE_WORKLOAD;
  if (workload) {
    // QA fix M5: sanitize workload value to prevent header injection
    const safeWorkload = workload.replace(/[;\s\r\n]/g, "_");
    header = header.replace(/;$/, ` cc_workload=${safeWorkload};`);
  }
  return header;
}
```

**Purpose:** Generates the `x-anthropic-billing-header` system prompt text block. Includes version fingerprint and optional workload hint.

**Header Format:**

- **Standard:** `x-anthropic-billing-header: cc_version={version}.{fingerprint}; cc_entrypoint={entrypoint}; cch=00000;`
- **Bedrock:** `x-anthropic-billing-header: cc_version={version}.{fingerprint}; cc_entrypoint={entrypoint};` (no cch)
- **With workload:** Appends ` cc_workload={workload};`

> **v2.1.107 NOTE:** The `cch=00000` placeholder is now replaced post-serialization by `computeAndReplaceCCH()`. See below.

#### computeAndReplaceCCH() — CCH Attestation (v2.1.107+)

```javascript
const CCH_SEED = 0x6e52736ac806831en; // Attestation.zig seed (unchanged since v2.1.96)
let _xxh64Raw = null;
const _xxhashReady = xxhashInit().then((h) => {
  _xxh64Raw = h.h64Raw;
});

async function computeAndReplaceCCH(body) {
  if (typeof body !== "string" || !body.includes("cch=00000")) return body;
  await _xxhashReady;
  if (!_xxh64Raw) return body;
  const bodyBytes = Buffer.from(body, "utf-8");
  const hash = _xxh64Raw(bodyBytes, CCH_SEED);
  const cch = (hash & 0xfffffn).toString(16).padStart(5, "0");
  return body.replace("cch=00000", `cch=${cch}`);
}
```

**Purpose:** Replaces the static `cch=00000` placeholder in the serialized JSON body with a 5-hex-char attestation hash. Called after `JSON.stringify()` but before sending the request.

**Algorithm:** `xxHash64(bodyBytes, seed) & 0xFFFFF` → 5-char lowercase hex.

**Key details:**

- The seed `0x6E52736AC806831E` is extracted from the compiled Bun binary's `Attestation.zig` module
- The hash is computed over the full serialized body (including the `cch=00000` placeholder)
- After hashing, `cch=00000` is replaced with the computed value via string replacement
- This means the hash is computed with the placeholder still present — the server knows to expect this
- Bedrock/anthropicAws providers skip cch entirely (no `cch=00000` in the header)

**Environment Variables:**

- `CLAUDE_CODE_ATTRIBUTION_HEADER` → Toggle (default: enabled)
- `CLAUDE_CODE_ENTRYPOINT` → Entrypoint value (default: "unknown")
- `CLAUDE_CODE_WORKLOAD` → Optional workload hint (sanitized)

---

### 1.7 buildSystemPromptBlocks() — Lines 5793-5900

```javascript
function buildSystemPromptBlocks(system, signature) {
  const titleGeneratorRequest = isTitleGeneratorSystemBlocks(system);

  let sanitized = system.map((item) => ({
    ...item,
    text: compactSystemText(sanitizeSystemText(item.text), signature.promptCompactionMode),
  }));

  if (titleGeneratorRequest) {
    sanitized = [{ type: "text", text: COMPACT_TITLE_GENERATOR_SYSTEM_PROMPT }];
  } else if (signature.promptCompactionMode !== "off") {
    sanitized = dedupeSystemBlocks(sanitized);
  }

  if (!signature.enabled) {
    return sanitized;
  }

  const filtered = sanitized.filter(
    (item) => !item.text.startsWith("x-anthropic-billing-header:") && !KNOWN_IDENTITY_STRINGS.has(item.text),
  );

  const blocks = [];
  const billingHeader = buildAnthropicBillingHeader(
    signature.claudeCliVersion,
    signature.firstUserMessage,
    signature.provider,
  );
  if (billingHeader) {
    // Billing header: no cache_control (null scope — never cached)
    blocks.push({ type: "text", text: billingHeader });
  }

  // Compute cache_control once — used for identity block AND filtered blocks.
  // TTL must be non-decreasing across tools → system → messages, so all cached
  // system blocks must share the same TTL to avoid "1h after 5m" API rejection.
  const effectiveCachePolicy = signature.cachePolicy || { ttl: "1h", ttl_supported: true };
  const hasTtl = effectiveCachePolicy.ttl !== "off" && effectiveCachePolicy.ttl_supported !== false;

  // CC v2.1.90 cache_control scoping (verified against bundle WQ() function):
  // - scope "global" is only emitted for static pre-boundary blocks
  // - scope "org" is internal-only, NEVER emitted on the wire
  // - identity block gets no cache_control in boundary mode, or {type:"ephemeral"} in fallback
  const baseCacheControl = hasTtl ? { type: "ephemeral", ttl: effectiveCachePolicy.ttl } : { type: "ephemeral" };
  const globalCacheControl = hasTtl
    ? { type: "ephemeral", scope: "global", ttl: effectiveCachePolicy.ttl }
    : { type: "ephemeral", scope: "global" };

  // Identity block: per CC v2.1.90, gets {type:"ephemeral"} with NO scope field.
  // In boundary mode CC assigns cacheScope:null (no cache_control at all), but
  // we always include it for better cache hit rates on the proxy side.
  blocks.push({ type: "text", text: CLAUDE_CODE_IDENTITY_STRING, cache_control: baseCacheControl });

  // Real CC (utils/api.ts splitSysPromptPrefix): ALL user system blocks are joined
  // with '\n\n' into a SINGLE text block. This is true in ALL modes (default, MCP, boundary).
  // Wire format: [billing (no cache), identity (ephemeral), ONE_JOINED_BLOCK (ephemeral)]
  // Sending separate blocks is a detectable fingerprinting signal.
  if (filtered.length > 0) {
    const useBoundary =
      signature.cachePolicy?.boundary_marker || isTruthyEnv(process.env.CLAUDE_CODE_FORCE_GLOBAL_CACHE);

    if (useBoundary) {
      // Global cache mode: split blocks into static (pre-boundary) and dynamic (post-boundary).
      // Real CC (splitSysPromptPrefix boundary path):
      //   static blocks → joined + cacheScope:'global' → cache_control:{type:'ephemeral',scope:'global',ttl:'1h'}
      //   dynamic blocks → joined + cacheScope:null → NO cache_control
      // We use a heuristic to find the split point (environment/date/CWD info = dynamic).
      const splitIndex = filtered.findIndex((block) => {
        const text = block.text.toLowerCase();
        return (
          text.includes("working directory") ||
          text.includes("today's date") ||
          text.includes("current date") ||
          text.includes("environment") ||
          text.includes("platform:")
        );
      });

      const effectiveSplit = splitIndex > 0 ? splitIndex : Math.ceil(filtered.length / 2);

      // Static blocks (before boundary): joined into ONE block with global cache
      const staticText = filtered
        .slice(0, effectiveSplit)
        .map((b) => b.text)
        .join("\n\n");
      if (staticText) {
        blocks.push({ type: "text", text: staticText, cache_control: globalCacheControl });
      }

      // Dynamic blocks (after boundary): joined into ONE block with NO cache
      const dynamicText = filtered
        .slice(effectiveSplit)
        .map((b) => b.text)
        .join("\n\n");
      if (dynamicText) {
        blocks.push({ type: "text", text: dynamicText });
      }
    } else {
      // Default mode (and MCP tools mode): ALL filtered blocks joined into ONE block.
      // Real CC (splitSysPromptPrefix default/MCP path):
      //   rest.join('\n\n') → cacheScope:'org' → cache_control:{type:'ephemeral',ttl:'1h'}
      const joinedText = filtered.map((b) => b.text).join("\n\n");
      blocks.push({ type: "text", text: joinedText, cache_control: baseCacheControl });
    }
  }

  return blocks;
}
```

**Purpose:** Constructs the final system prompt blocks array, including billing header, identity string, and cache control markers. This is the most critical function for mimese fidelity.

**Block Order (Output):**

1. Billing header (if enabled, no cache_control)
2. Identity string (with baseCacheControl)
3. User system blocks (joined, with optional cache_control based on boundary mode)

**Cache Modes:**

- **Boundary mode:** Static blocks (global cache) → Dynamic blocks (no cache)
- **Default mode:** All blocks joined (ephemeral cache)

**Environment Variables:**

- `CLAUDE_CODE_FORCE_GLOBAL_CACHE` → Force boundary mode

---

### 1.8 buildAnthropicBetaHeader() — Lines 5914-6072

```javascript
/**
 * @param {string} incomingBeta
 * @param {boolean} signatureEnabled
 * @param {string} model
 * @param {"anthropic" | "bedrock" | "vertex" | "foundry"} provider
 * @param {string[]} [customBetas]
 * @param {import('./lib/config.mjs').AccountSelectionStrategy} [strategy]
 * @param {string} [requestPath]
 * @param {boolean} [hasFileReferences]
 * @param {{ use1MContext?: boolean }} [adaptiveOverride] - When set, overrides the static hasOneMillionContext() check.
 * @returns {string}
 */
function buildAnthropicBetaHeader(
  incomingBeta,
  signatureEnabled,
  model,
  provider,
  customBetas,
  strategy,
  requestPath,
  hasFileReferences,
  adaptiveOverride,
  tokenEconomy,
  microcompactBetas, // NEW 11th param
) {
  const incomingBetasList = incomingBeta
    .split(",")
    .map((b) => b.trim())
    .filter(Boolean);

  const betas = ["oauth-2025-04-20"];
  const disableExperimentalBetas = isTruthyEnv(process.env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS);
  const isMessagesCountTokensPath = requestPath === "/v1/messages/count_tokens";
  const isFilesEndpoint = requestPath?.startsWith("/v1/files") ?? false;

  if (!signatureEnabled) {
    betas.push("interleaved-thinking-2025-05-14");
    if (isMessagesCountTokensPath) {
      betas.push(TOKEN_COUNTING_BETA_FLAG);
    }
    let mergedBetas = [...new Set([...betas, ...incomingBetasList])];
    if (disableExperimentalBetas) {
      mergedBetas = mergedBetas.filter((beta) => !EXPERIMENTAL_BETA_FLAGS.has(beta));
    }
    return mergedBetas.join(",");
  }

  const nonInteractive = isNonInteractiveMode();
  const haiku = isHaikuModel(model);
  const isRoundRobin = strategy === "round-robin";
  const te = tokenEconomy || {};

  // === ALWAYS-ON BETAS (Claude Code v2.1.90 base set) ===
  // These are ALWAYS included regardless of env vars or feature flags.
  if (!haiku) {
    betas.push(CLAUDE_CODE_BETA_FLAG); // "claude-code-20250219"
  }

  // Tool search: use provider-aware header.
  // 1P/Foundry u2192 advanced-tool-use-2025-11-20 (enables broader tool capabilities)
  // Vertex/Bedrock u2192 tool-search-tool-2025-10-19 (3P-compatible subset)
  if (provider === "vertex" || provider === "bedrock") {
    betas.push("tool-search-tool-2025-10-19");
  } else {
    betas.push(ADVANCED_TOOL_USE_BETA_FLAG); // "advanced-tool-use-2025-11-20"
  }

  betas.push(FAST_MODE_BETA_FLAG); // "fast-mode-2026-02-01"
  betas.push(EFFORT_BETA_FLAG); // "effort-2025-11-24"

  // Interleaved thinking — always-on unless explicitly disabled
  if (!isTruthyEnv(process.env.DISABLE_INTERLEAVED_THINKING)) {
    betas.push("interleaved-thinking-2025-05-14");
  }

  // Context 1M — when adaptive override is provided, use it; otherwise fall back to static check.
  {
    const use1M =
      adaptiveOverride && typeof adaptiveOverride.use1MContext === "boolean"
        ? adaptiveOverride.use1MContext
        : hasOneMillionContext(model);
    if (use1M) {
      betas.push("context-1m-2025-08-07");
    }
  }

  // Prompt caching scope — always-on EXCEPT in round-robin (per-workspace state conflicts)
  if (!isRoundRobin) {
    betas.push("prompt-caching-scope-2026-01-05");
  }

  // === CONDITIONAL BETAS (model/context-dependent) ===

  // Context management — gated to Claude 4+ models in CC v2.1.90.
  // Excluded for Claude 3.x (not supported). Always-on for Claude 4+ on 1P/Foundry.
  if (!/claude-3-/i.test(model)) {
    betas.push("context-management-2025-06-27");
  }

  // Structured outputs: only -2025-12-15 is active in v2.1.90 runtime.
  // token-efficient-tools-2026-03-28 was fully removed from v90 bundle.
  if (supportsStructuredOutputs(model)) {
    betas.push("structured-outputs-2025-12-15");
  }

  // Web search — for models that support it
  if (supportsWebSearch(model)) {
    betas.push("web-search-2025-03-05");
  }

  // Files API — scoped to file endpoints/references
  if (isFilesEndpoint || hasFileReferences) {
    betas.push("files-api-2025-04-14");
  }

  // Token counting endpoint
  if (isMessagesCountTokensPath) {
    betas.push(TOKEN_COUNTING_BETA_FLAG);
  }

  // === TOKEN ECONOMY BETAS (config-controlled) ===

  // redact-thinking: suppresses thinking summaries server-side.
  // When enabled, API returns redacted_thinking blocks instead of summaries.
  // Saves bandwidth and tokens for users who don't inspect thinking.
  if (te.redact_thinking && !disableExperimentalBetas) {
    betas.push("redact-thinking-2026-02-12");
  }

  // summarize-connector-text-2026-03-13 was removed in v2.1.90 (dead slot njq="").
  // compact-2026-01-12 and mcp-client-2025-11-20 exist only in docs, not runtime.

  // afk-mode — NOT auto-included (requires user opt-in)
  // Available via: /anthropic betas add afk-mode-2026-01-31

  // === MICROCOMPACT BETAS (context-aware, Phase 3 Task 3.4) ===
  if (microcompactBetas?.length) {
    for (const mb of microcompactBetas) {
      if (!betas.includes(mb)) betas.push(mb);
    }
  }

  // Merge incoming betas from the original request
  let mergedBetas = [...new Set([...betas, ...incomingBetasList])];

  // Add custom betas from config
  if (customBetas?.length) {
    for (const custom of customBetas) {
      const resolved = BETA_SHORTCUTS.get(custom) || custom;
      if (resolved && !mergedBetas.includes(resolved)) {
        mergedBetas.push(resolved);
      }
    }
  }

  // Filter out experimental betas only if explicitly disabled.
  // WARNING: The EXPERIMENTAL_BETA_FLAGS set overlaps with most always-on betas.
  // Enabling CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS effectively strips Claude Code
  // mimicry betas, leaving only oauth-2025-04-20, claude-code-20250219, and effort-*.
  // Use this escape hatch only for debugging or when betas cause API rejections.
  if (disableExperimentalBetas) {
    mergedBetas = mergedBetas.filter((beta) => !EXPERIMENTAL_BETA_FLAGS.has(beta));
  }

  // Remove betas unsupported by Bedrock
  if (provider === "bedrock") {
    mergedBetas = mergedBetas.filter((beta) => !BEDROCK_UNSUPPORTED_BETAS.has(beta));
  }

  return mergedBetas.join(",");
}
```

**Purpose:** Constructs the `anthropic-beta` header with all required Claude Code betas. 11 parameters cover signature status, model, provider, custom settings.

**Always-On Betas (v2.1.90+):**

- `oauth-2025-04-20` (foundation)
- `claude-code-20250219` (except Haiku)
- `advanced-tool-use-2025-11-20` (1P/Foundry) OR `tool-search-tool-2025-10-19` (Bedrock/Vertex)
- `fast-mode-2026-02-01`
- `effort-2025-11-24`
- `interleaved-thinking-2025-05-14`
- `context-1m-2025-08-07` (if model supports 1M context)
- `prompt-caching-scope-2026-01-05` (except round-robin strategy)
- `context-management-2025-06-27` (Claude 4+)

**Conditional Betas:**

- `structured-outputs-2025-12-15` (if model supports)
- `web-search-2025-03-05` (if model supports)
- `files-api-2025-04-14` (files endpoint or `file_id` references)
- `token-counting-2024-11-01` (`/v1/messages/count_tokens`)

**Environment Variables:**

- `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS` → Strip experimental betas
- `DISABLE_INTERLEAVED_THINKING` → Skip interleaved thinking

---

### 1.9 getStainlessOs() — Lines 6130-6135

```javascript
function getStainlessOs(value) {
  if (value === "darwin") return "macOS";
  if (value === "win32") return "Windows";
  if (value === "linux") return "Linux";
  return value;
}
```

**Purpose:** Maps Node.js `process.platform` values to Stainless SDK header values for `x-stainless-os`.

**Mapping:**

- `darwin` → `macOS`
- `win32` → `Windows`
- `linux` → `Linux`
- (other) → passthrough

---

### 1.10 getStainlessArch() — Lines 6142-6146

```javascript
/**
 * Normalize Node.js arch to Stainless arch header value.
 * @param {string} value
 * @returns {string}
 */
function getStainlessArch(value) {
  if (value === "x64") return "x64";
  if (value === "arm64") return "arm64";
  return value;
}
```

**Purpose:** Normalizes `process.arch` to Stainless SDK header value for `x-stainless-arch`.

**Mapping:**

- `x64` → `x64`
- `arm64` → `arm64`
- (other) → passthrough

---

### 1.11 buildRequestHeaders() — Lines 6186-6308

```javascript
/**
 * Build request headers from input and init, applying OAuth requirements.
 * Preserves behaviors D1-D7.
 *
 * @param {any} input
 * @param {Record<string, any>} requestInit
 * @param {string} accessToken
 * @param {string | undefined} requestBody
 * @param {URL | null} requestUrl
 * @param {{enabled: boolean, claudeCliVersion: string, strategy?: import('./lib/config.mjs').AccountSelectionStrategy, customBetas?: string[], sessionId?: string}} signature
 * @returns {Headers}
 */
function buildRequestHeaders(
  input,
  requestInit,
  accessToken,
  requestBody,
  requestUrl,
  signature,
  adaptiveOverride,
  tokenEconomy,
) {
  const requestHeaders = new Headers();
  if (input instanceof Request) {
    input.headers.forEach((value, key) => {
      requestHeaders.set(key, value);
    });
  }
  if (requestInit.headers) {
    if (requestInit.headers instanceof Headers) {
      requestInit.headers.forEach((value, key) => {
        requestHeaders.set(key, value);
      });
    } else if (Array.isArray(requestInit.headers)) {
      for (const [key, value] of requestInit.headers) {
        if (typeof value !== "undefined") {
          requestHeaders.set(key, String(value));
        }
      }
    } else {
      for (const [key, value] of Object.entries(requestInit.headers)) {
        if (typeof value !== "undefined") {
          requestHeaders.set(key, String(value));
        }
      }
    }
  }

  // Preserve all incoming beta headers while ensuring OAuth requirements
  const incomingBeta = requestHeaders.get("anthropic-beta") || "";
  const { model, tools, messages, hasFileReferences } = parseRequestBodyMetadata(requestBody);
  const provider = detectProvider(requestUrl);
  const mergedBetas = buildAnthropicBetaHeader(
    incomingBeta,
    signature.enabled,
    model,
    provider,
    signature.customBetas,
    signature.strategy,
    requestUrl?.pathname,
    hasFileReferences,
    adaptiveOverride,
    tokenEconomy,
  );

  const authTokenOverride = process.env.ANTHROPIC_AUTH_TOKEN?.trim();
  const bearerToken = authTokenOverride || accessToken;

  requestHeaders.set("authorization", `Bearer ${bearerToken}`);
  requestHeaders.set("anthropic-beta", mergedBetas);
  requestHeaders.set("user-agent", buildExtendedUserAgent(signature.claudeCliVersion));
  if (signature.enabled) {
    requestHeaders.set("anthropic-version", "2023-06-01");
    // Fix #6: x-app is "cli" for interactive mode, "cli-bg" for background tasks.
    // Real CC (client.ts:106): 'x-app': 'cli' (foreground) or 'cli-bg' (background agent).
    requestHeaders.set("x-app", isTruthyEnv(process.env.CLAUDE_CODE_BACKGROUND) ? "cli-bg" : "cli");
    // Fix #3: X-Claude-Code-Session-Id — sent in ALL requests by real CC (client.ts:108).
    // Value matches metadata.user_id.session_id for server-side correlation.
    if (signature.sessionId) {
      requestHeaders.set("X-Claude-Code-Session-Id", signature.sessionId);
    }
    requestHeaders.set("x-stainless-arch", getStainlessArch(process.arch));
    requestHeaders.set("x-stainless-lang", "js");
    requestHeaders.set("x-stainless-os", getStainlessOs(process.platform));
    requestHeaders.set("x-stainless-package-version", getSdkVersion(signature.claudeCliVersion));
    requestHeaders.set("x-stainless-runtime", "node");
    requestHeaders.set("x-stainless-runtime-version", process.version);
    const incomingRetryCount = requestHeaders.get("x-stainless-retry-count");
    requestHeaders.set(
      "x-stainless-retry-count",
      incomingRetryCount && !isFalsyEnv(incomingRetryCount) ? incomingRetryCount : "0",
    );
    // x-stainless-timeout: sent only for non-streaming requests.
    // Claude Code sends 600 (10 minutes) as the default timeout in seconds.
    // For streaming requests, the SDK omits this header entirely.
    if (requestBody) {
      try {
        const parsed = JSON.parse(requestBody);
        // stream defaults to true in Claude Code; only explicitly false means non-streaming
        if (parsed.stream === false) {
          requestHeaders.set("x-stainless-timeout", "600");
        }
        // Streaming requests: omit x-stainless-timeout (real SDK behavior)
      } catch {
        // Non-JSON body or parse error — omit header (safe default)
      }
    }
    const stainlessHelpers = buildStainlessHelperHeader(tools, messages);
    if (stainlessHelpers) {
      requestHeaders.set("x-stainless-helper", stainlessHelpers);
    }

    for (const [key, value] of Object.entries(parseAnthropicCustomHeaders())) {
      requestHeaders.set(key, value);
    }
    if (process.env.CLAUDE_CODE_CONTAINER_ID) {
      requestHeaders.set("x-claude-remote-container-id", process.env.CLAUDE_CODE_CONTAINER_ID);
    }
    if (process.env.CLAUDE_CODE_REMOTE_SESSION_ID) {
      requestHeaders.set("x-claude-remote-session-id", process.env.CLAUDE_CODE_REMOTE_SESSION_ID);
    }
    if (process.env.CLAUDE_AGENT_SDK_CLIENT_APP) {
      requestHeaders.set("x-client-app", process.env.CLAUDE_AGENT_SDK_CLIENT_APP);
    }
    if (isTruthyEnv(process.env.CLAUDE_CODE_ADDITIONAL_PROTECTION)) {
      requestHeaders.set("x-anthropic-additional-protection", "true");
    }

    // Claude Code v2.1.84: x-client-request-id — unique UUID per request for debugging timeouts.
    requestHeaders.set("x-client-request-id", randomUUID());
  }
  requestHeaders.delete("x-api-key");

  return requestHeaders;
}
```

**Purpose:** Main header composition function. When `signature.enabled=true`, injects all Claude Code mimicry headers. Always sets OAuth bearer token and beta header.

**Always-Set Headers:**

- `authorization: Bearer {token}`
- `anthropic-beta: {mergedBetas}`
- `user-agent: claude-cli/{version} (external, {entrypoint}...)`

**Signature-Enabled Headers (signature.enabled=true):**

- `anthropic-version: 2023-06-01`
- `x-app: cli` or `cli-bg` (per `CLAUDE_CODE_BACKGROUND`)
- `X-Claude-Code-Session-Id: {sessionId}`
- `x-stainless-arch, x-stainless-lang, x-stainless-os`
- `x-stainless-package-version, x-stainless-runtime, x-stainless-runtime-version`
- `x-stainless-retry-count: 0` (default)
- `x-stainless-timeout: 600` (non-streaming only)
- `x-stainless-helper: {aggregated}`
- `x-client-request-id: {uuid}` (v2.1.84+)
- Custom headers from `ANTHROPIC_CUSTOM_HEADERS` (if set)
- Environment-driven headers (container-id, remote-session-id, client-app, additional-protection)

**Special Cases:**

- `x-api-key` is **always deleted** (OAuth only)
- `x-stainless-timeout` is **omitted for streaming** requests

---

## 2. COMMENT REFERENCES TO MIMESE/FINGERPRINT/DIVERGENCE

### Lines with "Fix #" comments:

| Line | Comment                                                                               |
| ---- | ------------------------------------------------------------------------------------- |
| 5613 | `Fix #1: cc_version suffix is the 3-char fingerprint hash, NOT the model ID.`         |
| 5620 | `Fix #4: cch is a static "00000" placeholder for Bun's native client attestation.`    |
| 6247 | `Fix #6: x-app is "cli" for interactive mode, "cli-bg" for background tasks.`         |
| 6250 | `Fix #3: X-Claude-Code-Session-Id — sent in ALL requests by real CC (client.ts:108).` |

### Lines with "RE doc" references:

| Line | Context                                                                                   |
| ---- | ----------------------------------------------------------------------------------------- |
| 2472 | `Track 529/503 retries (max 2 per RE doc §5.5)`                                           |
| 2521 | `Refresh 5 minutes before expiry to avoid mid-request token expiration (RE doc §1.10)`    |
| 3260 | `x-should-retry: true forces a retry for service-wide errors (RE doc §5.5)`               |
| 3338 | `per RE doc §5.5 (Stainless SDK retries 500+ codes up to maxServiceRetries times)`        |
| 4800 | `RE doc §7.2 — present but empty (privacy: don't leak email in telemetry)`                |
| 4808 | `RE doc §7.2 — default consumer for Claude.ai OAuth`                                      |
| 4809 | `RE doc §7.2 — always cli`                                                                |
| 4810 | `RE doc §7.2 — populated at send time if needed`                                          |
| 6398 | `Claude Code always uses temperature: 1 for non-thinking requests (RE doc §5.2, never 0)` |

### Lines with "mimese", "fingerprint", "deviation", "diverge":

| Line | Context                                                                            |
| ---- | ---------------------------------------------------------------------------------- | --- | -------------- |
| 3923 | `Hash a string for cache source fingerprinting.`                                   |
| 5599 | `Claude Code v2.1.92: cc_version includes 3-char fingerprint hash (not model ID).` |
| 5602 | `Real CC (system.ts:78): version = ${MACRO.VERSION}.${fingerprint}`                |
| 5615 | `which matches computeFingerprint() in the real CC source (utils/fingerprint.ts).` |
| 5618 | `const fingerprint = computeBillingCacheHash(firstUserMessage                      |     | "", version);` |
| 5849 | `Sending separate blocks is a detectable fingerprinting signal.`                   |

---

## 3. RELATED DOCUMENTATION FILES

### 3.1 mimese-http-header-system-prompt.md

**Status:** Present at `D:\git\opencode-anthropic-fix\docs\mimese-http-header-system-prompt.md` (594 lines)

**Key Sections:**

- Control switch (`signature_emulation`)
- Claude CLI version fetching strategy
- Request flow and protocol sequence
- HTTP header catalog (always-applied + signature-enabled)
- Beta header composition rules (section 5)
- System prompt mimicry (block normalization, sanitization, injection)
- Body fields (`metadata.user_id`, `context_management`, `speed`, `output_config`)
- OAuth token-layer user-agent (axios-fingerprint)
- WebFetch user-agent (intentional divergence note)

---

### 3.2 DIVERGENCE_ANALYSIS.md

**Status:** Present at `D:\git\opencode-anthropic-fix\DIVERGENCE_ANALYSIS.md` (546 lines)

**Key Findings:**

1. **Function Signature Divergence** — Plugin uses 2 params (system, signature) vs Real CC's 3 params (systemPrompt, enablePromptCaching, options)
2. **Cache Scoping Strategy** — Real CC has 3 distinct paths (tool-based org, boundary global, fallback org); plugin has 2 simplified modes
3. **Identity String Handling** — Real CC selects dynamically via `getCLISyspromptPrefix()`; plugin hardcodes `CLAUDE_CODE_IDENTITY_STRING`
4. **Billing Header (Attribution)** — Real CC uses `NATIVE_CLIENT_ATTESTATION` feature flag; plugin uses hardcoded provider check
5. **Org-Scope Support** — Real CC supports `cacheScope: 'org'`; plugin has no 'org' scope concept
6. **Block Assembly** — Real CC delegates to `splitSysPromptPrefix()`; plugin implements logic directly

**Critical Divergences (Must Fix):**

- Implement three-path cache scoping instead of two
- Support 'org' scope in addition to 'global'
- Respect `skipGlobalCacheForSystemPrompt` flag
- Implement precise boundary marker detection (not heuristic)

---

### 3.3 CODE_COMPARISON_REFERENCE.md

**Status:** Present at `D:\git\opencode-anthropic-fix\CODE_COMPARISON_REFERENCE.md` (497 lines)

**Content:** Side-by-side comparison of real Claude Code implementation vs plugin:

**File A:** Real CC Constants (system.ts lines 10-95)

- `DEFAULT_PREFIX`, `AGENT_SDK_CLAUDE_CODE_PRESET_PREFIX`, `AGENT_SDK_PREFIX`
- `getCLISyspromptPrefix()` function signature and logic
- `getAttributionHeader()` with `NATIVE_CLIENT_ATTESTATION` feature flag

**File B:** Real CC buildSystemPromptBlocks Entry Point (claude.ts:1356-3237)

- Call site with `systemPrompt` array, `enablePromptCaching` flag, options
- `buildSystemPromptBlocks()` function signature
- Maps to `splitSysPromptPrefix()` and `getCacheControl()`

**File C:** Real CC Cache Scoping Logic (api.ts:321-435)

- `splitSysPromptPrefix()` complete implementation with 3 paths
- `getCacheControl()` function (lines 358-374)
- Boundary marker detection vs heuristic

**File D:** Plugin Implementation Comparison

- Shows all 3 functions as implemented in index.mjs
- Call site at line 6370

---

## 4. CONSTANTS AND ENVIRONMENT VARIABLES

### Header-Related Constants (from code):

| Constant                      | Value                                                         |
| ----------------------------- | ------------------------------------------------------------- |
| `BILLING_HASH_SALT`           | `"59cf53e54c78"`                                              |
| `BILLING_HASH_INDICES`        | `[4, 7, 20]`                                                  |
| `CLAUDE_CODE_BETA_FLAG`       | `"claude-code-20250219"`                                      |
| `ADVANCED_TOOL_USE_BETA_FLAG` | `"advanced-tool-use-2025-11-20"`                              |
| `FAST_MODE_BETA_FLAG`         | `"fast-mode-2026-02-01"`                                      |
| `EFFORT_BETA_FLAG`            | `"effort-2025-11-24"`                                         |
| `TOKEN_COUNTING_BETA_FLAG`    | `"token-counting-2024-11-01"`                                 |
| `CLAUDE_CODE_IDENTITY_STRING` | `"You are Claude Code, Anthropic's official CLI for Claude."` |

### Environment Variables (from code):

| Variable                                 | Purpose                                   |
| ---------------------------------------- | ----------------------------------------- |
| `CLAUDE_CODE_ENTRYPOINT`                 | User agent entrypoint (default: "cli")    |
| `CLAUDE_AGENT_SDK_VERSION`               | Optional agent-sdk suffix in user-agent   |
| `CLAUDE_AGENT_SDK_CLIENT_APP`            | Optional client-app suffix in user-agent  |
| `CLAUDE_CODE_BACKGROUND`                 | Set to "1" for `x-app: cli-bg`            |
| `ANTHROPIC_AUTH_TOKEN`                   | Override bearer token                     |
| `CLAUDE_CODE_ATTRIBUTION_HEADER`         | Toggle billing header (default: enabled)  |
| `CLAUDE_CODE_WORKLOAD`                   | Optional workload hint (sanitized)        |
| `CLAUDE_CODE_FORCE_GLOBAL_CACHE`         | Force global cache mode in system blocks  |
| `DISABLE_INTERLEAVED_THINKING`           | Skip interleaved-thinking-2025-05-14 beta |
| `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS` | Strip experimental betas                  |
| `CLAUDE_CODE_CONTAINER_ID`               | Maps to `x-claude-remote-container-id`    |
| `CLAUDE_CODE_REMOTE_SESSION_ID`          | Maps to `x-claude-remote-session-id`      |
| `ANTHROPIC_CUSTOM_HEADERS`               | Multiline header injection (parse)        |
| `CLAUDE_CODE_EXTRA_METADATA`             | JSON object merged into metadata.user_id  |
| `OPENCODE_ANTHROPIC_SIGNATURE_USER_ID`   | Raw string override for user_id (no JSON) |

---

## 5. REFERENCE DOCUMENTS SUMMARY

| Document                            | Lines | Purpose                                        |
| ----------------------------------- | ----- | ---------------------------------------------- |
| mimese-http-header-system-prompt.md | 594   | Implementation guide for header/system mimicry |
| DIVERGENCE_ANALYSIS.md              | 546   | Critical gaps vs real CC implementation        |
| CODE_COMPARISON_REFERENCE.md        | 497   | Side-by-side source code comparison            |

---

## 6. TESTING & VERIFICATION NOTES

### From test files:

**index.test.mjs**

- Line 2317: 503 is retried up to 2 times (RE doc §5.2)
- Line 2944: Opus 4.6 always uses adaptive thinking (RE doc §5.2)
- Line 2968: Adaptive for all Opus 4.6 regardless of budget

**regression.test.mjs**

- Lines 195-791: Fix #1-#15 conformance tests
- Line 791: `billing cc_version includes 3-char fingerprint hash (not model ID)`
- Line 859: `metadata.user_id JSON format (RE doc §4.2)`

---

**End of Extraction Document**

Generated: 2026-04-07  
Completeness: All 11 function extracts, related documentation, and comment references included.
