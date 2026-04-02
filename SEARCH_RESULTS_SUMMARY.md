# System Prompt Search Results Summary

**Directory:** `D:\git\opencode-anthropic-fix\tmp\src88\src`  
**Date:** 2026-04-01

## Overview

Comprehensive scan of TypeScript source files for system prompt-related content. Found the main system prompt architecture, identity blocks, billing headers, and tengu event tracking system.

---

## 1. IDENTITY BLOCKS ("You are Claude...")

### Main Identity Variations (constants/system.ts)

Located in: **D:\git\opencode-anthropic-fix\tmp\src88\src\constants\system.ts** (Lines 10-18)

Three identity prefixes used depending on runtime context:

1. **DEFAULT_PREFIX** (Line 10)

   ```
   "You are Claude Code, Anthropic's official CLI for Claude."
   ```

2. **AGENT_SDK_CLAUDE_CODE_PRESET_PREFIX** (Line 11)

   ```
   "You are Claude Code, Anthropic's official CLI for Claude, running within the Claude Agent SDK."
   ```

3. **AGENT_SDK_PREFIX** (Line 12)
   ```
   "You are a Claude agent, built on Anthropic's Claude Agent SDK."
   ```

**Context Selection Logic** (Lines 30-46):

- Function: `getCLISyspromptPrefix(options?: { isNonInteractive, hasAppendSystemPrompt })`
- For Vertex API: Always uses DEFAULT_PREFIX
- For non-interactive sessions WITH appendSystemPrompt: Uses AGENT_SDK_CLAUDE_CODE_PRESET_PREFIX
- For non-interactive sessions WITHOUT appendSystemPrompt: Uses AGENT_SDK_PREFIX
- Otherwise: Uses DEFAULT_PREFIX

### Alternative Identity (prompts.ts, Line 452)

**Location:** `D:\git\opencode-anthropic-fix\tmp\src88\src\constants\prompts.ts:452`

- Used when `process.env.CLAUDE_CODE_SIMPLE` is truthy
- Simple format with CWD and date: `"You are Claude Code, Anthropic's official CLI for Claude.\n\nCWD: ${getCwd()}\nDate: ${getSessionStartDate()}"`

### Interactive Agent Identity (prompts.ts, Line 180)

**Location:** `D:\git\opencode-anthropic-fix\tmp\src88\src\constants\prompts.ts:180`

```
"You are an interactive agent that helps users [according to output style / with software engineering tasks].
Use the instructions below and the tools available to you to assist the user."
```

---

## 2. SYSTEM PROMPT STRUCTURE & ARCHITECTURE

### Main System Prompt Builder

**File:** `D:\git\opencode-anthropic-fix\tmp\src88\src\constants\prompts.ts:444-914`

**Function:** `getSystemPrompt(tools, model, additionalWorkingDirectories, mcpClients)`

### Prompt Structure Sections (Lines 491-573)

The system prompt is built from modular sections using the `systemPromptSection()` and `DANGEROUS_uncachedSystemPromptSection()` pattern:

1. **session_guidance** - Session-specific guidance based on enabled tools
2. **memory** - Memory prompt (from memdir)
3. **ant_model_override** - Anthropic employee model-specific overrides
4. **env_info_simple** - Environment information
5. **language** - Language preference settings
6. **output_style** - Output style configuration
7. **mcp_instructions** - MCP server instructions (volatile - recomputes each turn)
8. **scratchpad** - Scratchpad instructions
9. **frc** - Function Result Clearing section
10. **summarize_tool_results** - Tool result summarization
11. **brief** - Brief section (when applicable)

**SYSTEM_PROMPT_DYNAMIC_BOUNDARY** (Lines 114-115):

- Marker separating static (globally cacheable) content from dynamic (user/session-specific) content
- Location in array determines cache scope eligibility
- Critical for prompt caching optimization

### System Prompt Type Definition

**File:** `D:\git\opencode-anthropic-fix\tmp\src88\src\utils\systemPromptType.ts`

Branded type for type safety:

```typescript
export type SystemPrompt = readonly string[] & {
  readonly __brand: "SystemPrompt";
};
```

---

## 3. BILLING & ATTRIBUTION HEADERS

### Attribution/Billing Header

**File:** `D:\git\opencode-anthropic-fix\tmp\src88\src\constants\system.ts:73-95`

**Function:** `getAttributionHeader(fingerprint: string)`

Header format:

```
x-anthropic-billing-header: cc_version=${version}.${fingerprint}; cc_entrypoint=${entrypoint};${cch}${workloadPair}
```

**Components:**

- `cc_version`: VERSION macro + fingerprint (from message chars)
- `cc_entrypoint`: Set via `CLAUDE_CODE_ENTRYPOINT` env var (default: "unknown")
- `cch`: Client attestation token placeholder (`cch=00000;`) when `NATIVE_CLIENT_ATTESTATION` enabled
- `cc_workload`: Workload routing hint from `getWorkload()` (e.g., cron-initiated requests)

**References in codebase:**

- Lines 339, 376, 418 in `D:\git\opencode-anthropic-fix\tmp\src88\src\utils\api.ts` - blocking/parsing logic
- Multiple references in `cli/print.ts` (lines 2721, etc.) with threading comments
- 103 total matches for "billing" or "Billing" across the codebase

---

## 4. PROACTIVE/AUTONOMOUS AGENT MODE

**File:** `D:\git\opencode-anthropic-fix\tmp\src88\src\constants\prompts.ts:466-489`

When `feature('PROACTIVE')` or `feature('KAIROS')` is enabled:

Identity changes to:

```
"You are an autonomous agent. Use the available tools to do useful work."
```

Simplified sections:

- System reminders
- Memory
- Language
- MCP instructions (if delta not enabled)
- Scratchpad
- Function result clearing
- Proactive section

---

## 5. COORDINATOR/ORCHESTRATION MODE

**File:** `D:\git\opencode-anthropic-fix\tmp\src88\src\coordinator\coordinatorMode.ts:116`

Alternative orchestration identity:

```
"You are Claude Code, an AI assistant that orchestrates software engineering tasks across multiple workers."
```

---

## 6. SYSTEM PROMPT SECTIONS MANAGEMENT

**File:** `D:\git\opencode-anthropic-fix\tmp\src88\src\constants\systemPromptSections.ts`

### Section Types:

1. **Cached Sections** (`systemPromptSection`):
   - Computed once, cached until `/clear` or `/compact`
   - Cache-break: false

2. **Volatile Sections** (`DANGEROUS_uncachedSystemPromptSection`):
   - Recomputes every turn
   - Breaks prompt cache when value changes
   - Used for: MCP instructions (dynamic server connections)
   - Requires explicit reason documentation

### Cache Management:

- `resolveSystemPromptSections()` - Resolves all sections with cache checking
- `clearSystemPromptSections()` - Called on `/clear` and `/compact`
- Also resets beta header latches for fresh evaluation

---

## 7. TENGU EVENT TRACKING SYSTEM

**Total matches:** 1094+ across codebase

### Key Tengu Events (System Prompt Related):

- `tengu_started` - Session startup (setup.ts:378)
- `tengu_exit` - Session exit (setup.ts:454)
- `tengu_session_memory_*` - Session memory events (sessionMemory.ts)
- `tengu_mcp_*` - MCP server events
- `tengu_plugin_*` - Plugin management events
- `tengu_oauth_*` - OAuth authentication events
- `tengu_skill_loaded` - Skill loading events
- `tengu_slate_*`, `tengu_surreal_*`, `tengu_cobalt_*` - Feature-gated events

### Feature Gates Using Tengu:

- `tengu_slate_prism`, `tengu_slate_thimble`
- `tengu_surreal_dali`
- `tengu_cobalt_lantern`
- `tengu_harbor_permissions`
- `tengu_attribution_header` (controls attribution header enablement)

---

## 8. SIMPLE PROMPT SECTIONS

### System Section (getSimpleSystemSection)

**Location:** prompts.ts:186-197

Includes:

- Tool execution and permission handling
- External data source warnings
- Prompt injection detection
- Hooks configuration
- Automatic message compression

### Tone and Style Section (getSimpleToneAndStyleSection)

**Location:** prompts.ts:430-442

- No emojis unless explicitly requested
- Short and concise responses
- File path references with line numbers (file_path:line_number)
- GitHub issue/PR format (owner/repo#123)
- No colons before tool calls

---

## 9. API REQUEST BUILDING

**File:** `D:\git\opencode-anthropic-fix\tmp\src88\src\services\api\claude.ts:1370-1379`

### System Prompt Processing:

1. Prepends system prompt block for API identification (line 1372)
2. Builds system prompt blocks with `buildSystemPromptBlocks()` function
3. Applies prompt caching if enabled
4. Handles query source and cache scope options

---

## 10. SEARCH PATTERNS NOT FOUND

### Empty Results:

- `TOOL_USE_GUIDELINES` / `tool_use_guidelines` - Not found in \*.ts files
- `tengu` + `identity` combined - No direct association found
- `identity` + `prompt` + `block` combined - No matching patterns (only "identity.agentId" in agent context)

---

## 11. CYBER RISK INSTRUCTION

**File:** `D:\git\opencode-anthropic-fix\tmp\src88\src\constants\cyberRiskInstruction.ts`

Imported and included in:

- Simple intro section (line 182)
- Autonomous agent section (line 474)

---

## FILE INDEX

| File                              | Purpose                                                            |
| --------------------------------- | ------------------------------------------------------------------ |
| constants/system.ts               | Identity prefixes, attribution headers, CLI prefix selection logic |
| constants/prompts.ts              | Main system prompt builder, section definitions, simple mode       |
| utils/systemPromptType.ts         | SystemPrompt branded type definition                               |
| constants/systemPromptSections.ts | Section caching and resolution logic                               |
| utils/api.ts                      | System prompt prefix splitting and parsing                         |
| services/api/claude.ts            | API request building with system prompts                           |
| constants/cyberRiskInstruction.ts | Cyber risk disclaimer content                                      |
| constants/outputStyles.ts         | Output style configurations with custom prompts                    |

---

## KEY INSIGHTS

1. **Multi-Context Identity**: System uses different identity blocks based on execution context (default CLI vs Agent SDK vs Coordinator mode)

2. **Modular Architecture**: System prompt built from composable, cacheable sections enabling prompt caching optimization

3. **Billing Attribution**: Sophisticated header system (x-anthropic-billing-header) with version fingerprinting, client attestation, and workload routing

4. **Dynamic Boundary**: Clear separation between globally-cacheable static content and session-specific dynamic content for optimal caching

5. **Volatile Sections**: MCP instructions marked as cache-breaking due to dynamic server connections between turns

6. **Feature Gating**: Heavy use of GrowthBook feature flags (tengu\_\*) for A/B testing and gradual rollout

7. **Simple Mode**: Alternative ultra-minimal system prompt when `CLAUDE_CODE_SIMPLE` env var enabled

8. **Autonomous Agent Mode**: Distinct identity and simplified section composition when proactive/autonomous mode enabled
