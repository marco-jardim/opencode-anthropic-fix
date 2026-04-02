# Exploration Index - OpenCode Anthropic Fix

This directory contains comprehensive exploration documents of the `opencode-anthropic-fix` codebase, created to understand message handling, tool use protocol, and API integration.

---

## 📚 Documentation Map

### Start Here (Pick Your Learning Style)

1. **`EXPLORATION_EXECUTIVE_SUMMARY.md`** ⭐ **START HERE**
   - 1-page executive overview
   - Project purpose, structure, key metrics
   - Ideal for: Getting the big picture quickly
   - Read time: 5-10 minutes

2. **`EXPLORATION_SUMMARY.md`** — **COMPREHENSIVE REFERENCE**
   - Complete technical breakdown (50+ pages when printed)
   - Every major component with code locations
   - Ideal for: Deep understanding, code navigation
   - Read time: 20-30 minutes

3. **`MESSAGE_FLOW_DIAGRAM.md`** — **VISUAL LEARNER**
   - ASCII flow diagrams and state machines
   - Request → transformation → response lifecycle
   - Ideal for: Understanding data flow visually
   - Read time: 10-15 minutes

4. **`TOOL_USE_CODE_EXAMPLES.md`** — **HANDS-ON EXAMPLES**
   - 8 real-world code examples with before/after
   - Demonstrates tool_use/tool_result pairing
   - Ideal for: Implementation understanding
   - Read time: 15-20 minutes

5. **`QUICK_REFERENCE.md`** — **CHEAT SHEET**
   - Line-by-line code location lookup tables
   - Constants, environment variables, patterns
   - Ideal for: During implementation/debugging
   - Read time: 5 minutes to scan, reference as needed

---

## 🎯 By Topic

### If You Want To Understand...

#### Tool Use & Tool Result Protocol

→ `TOOL_USE_CODE_EXAMPLES.md` (Examples 1, 2, 6, 8)  
→ `MESSAGE_FLOW_DIAGRAM.md` (Tool Use Pairing Protocol)  
→ `EXPLORATION_SUMMARY.md` (Sections: "Tool Use Block Detection", "Message Array Structure")

#### Message Transformation Pipeline

→ `MESSAGE_FLOW_DIAGRAM.md` (Detailed Message Transformation Flow)  
→ `TOOL_USE_CODE_EXAMPLES.md` (Examples 1, 3, 5)  
→ `EXPLORATION_SUMMARY.md` (Section: "Request Body Transformation")

#### Error Handling & Recovery

→ `EXPLORATION_SUMMARY.md` (Section: "Error Handling for Tool Calls")  
→ `MESSAGE_FLOW_DIAGRAM.md` (Error Handling Decision Tree)  
→ `TOOL_USE_CODE_EXAMPLES.md` (Examples 4, 7)

#### Account Switching & Retry Logic

→ `MESSAGE_FLOW_DIAGRAM.md` (Account Selection & Retry Flow)  
→ `EXPLORATION_SUMMARY.md` (Section: "Fetch Interceptor & Message Construction")  
→ `QUICK_REFERENCE.md` (Error Handling table)

#### SSE Streaming & Prefix Stripping

→ `TOOL_USE_CODE_EXAMPLES.md` (Example 3)  
→ `EXPLORATION_SUMMARY.md` (Section: "Response Handling & SSE Streaming")  
→ `MESSAGE_FLOW_DIAGRAM.md` (Response Stream Processing Flow)

#### Configuration & Storage

→ `QUICK_REFERENCE.md` (Configuration Flags, Env Variables)  
→ `EXPLORATION_SUMMARY.md` (Section: "Key Files for Message Handling")  
→ `EXPLORATION_EXECUTIVE_SUMMARY.md` (Architecture Highlights)

#### Testing & Validation

→ `QUICK_REFERENCE.md` (Testing Quick Lookup, Validation Checklist)  
→ `EXPLORATION_SUMMARY.md` (Section: "Testing Structure")  
→ `EXPLORATION_EXECUTIVE_SUMMARY.md` (Test Coverage)

---

## 🔍 Code Location Quick Jump

### For Developers Using These Docs

**In Your IDE, press Ctrl+G (Go to Line) and jump to:**

| What                   | File            | Line         |
| ---------------------- | --------------- | ------------ |
| Main fetch interceptor | index.mjs       | 2299         |
| Slash command removal  | index.mjs       | 4742         |
| MCP prefix addition    | index.mjs       | 6104         |
| Tool result synthesis  | index.mjs       | 6142         |
| Message prefill guard  | index.mjs       | 6133         |
| SSE prefix stripping   | index.mjs       | 6309         |
| Response wrapping      | index.mjs       | 6381         |
| Error classification   | lib/backoff.mjs | (file start) |

See `QUICK_REFERENCE.md` for complete line-by-line lookup tables.

---

## 📋 Document Details

### EXPLORATION_EXECUTIVE_SUMMARY.md

**Length:** ~400 lines | **Read time:** 10-15 min

**Sections:**

- What This Project Does (elevator pitch)
- Codebase Structure (file-by-file breakdown)
- Message Handling: The Core Flow (high-level overview)
- Tool Use Protocol (problem & solution)
- Three-Level Error Handling
- Test Coverage (680+ tests)
- Key Code Locations (quick reference table)
- Architecture Highlights
- Performance Characteristics
- Quality Assurance

**Best for:** Getting started, reporting to non-developers, understanding scope

---

### EXPLORATION_SUMMARY.md

**Length:** ~800 lines | **Read time:** 25-35 min

**Sections:**

1. Project Overview
   - What is this project?
   - How are Anthropic API messages handled?
   - Directory structure

2. Key Message Handling: Tool Use & Tool Result
   - Message Array Structure & Validation
   - Tool Use Block Detection & Tool Result Synthesis
   - Message Filtering: Slash Commands
   - Token Count Analysis

3. Fetch Interceptor & Message Construction
   - Main Entry Point
   - Request Body Transformation
   - Response Handling & SSE Streaming

4. Error Handling for Tool Calls
   - Error Classification
   - Mid-Stream Error Detection
   - Retry Logic

5. Key Files for Message Handling (lookup table)

6. Testing Structure

**Best for:** Complete understanding, implementation, debugging

---

### MESSAGE_FLOW_DIAGRAM.md

**Length:** ~600 lines | **Read time:** 15-25 min

**Diagrams:**

- High-Level Message Flow (10-box diagram)
- Detailed Message Transformation Flow (parse → filter → transform)
- Response Stream Processing Flow (SSE events → token extraction)
- Account Selection & Retry Flow (decision tree)
- Error Recovery: Overflow & Trimming
- Tool Use Pairing Protocol
- Summary of Key Transformations (table)

**Best for:** Understanding data flow, troubleshooting, visualizing processes

---

### TOOL_USE_CODE_EXAMPLES.md

**Length:** ~500 lines | **Read time:** 15-25 min

**Examples:**

1. Basic Tool Use Flow (simple case)
2. Multiple Tool Uses (parallel execution)
3. Tool Use Name Prefix Handling (outbound + inbound)
4. Context Overflow Recovery with Tool Use (trimming)
5. Slash Command Message Filtering (removal)
6. Token Counting with Tool Blocks (accounting)
7. Error Detection in Streaming Response (mid-stream)
8. Tool Result Grouping for Analysis (grouping)

**Best for:** Implementation reference, understanding use cases, debugging

---

### QUICK_REFERENCE.md

**Length:** ~300 lines | **Read time:** 5 min to scan, reference as needed

**Sections:**

- Message Handling Quick Lookup (3 tables: tool use, message array, fetch)
- Error Handling Quick Lookup (1 table)
- Key Constants & Config (1 table)
- Testing Quick Lookup (2 tables)
- Common Code Patterns (5 patterns)
- Debug Logging (how to enable, where to look)
- Env Variables That Affect Message Handling
- Configuration Flags
- Performance Considerations
- Common Issues & Fixes (troubleshooting table)
- Validation Checklist

**Best for:** During coding, debugging, quick lookup

---

## 🧭 Navigation Flowchart

```
START HERE?
    │
    ├─ I'm new → EXECUTIVE_SUMMARY
    │  │
    │  └─ Want more detail? → EXPLORATION_SUMMARY
    │     │
    │     └─ Visual person? → MESSAGE_FLOW_DIAGRAM
    │
    ├─ I'm debugging → QUICK_REFERENCE
    │  │
    │  └─ Need code examples? → TOOL_USE_CODE_EXAMPLES
    │
    ├─ I'm implementing → EXPLORATION_SUMMARY (for architecture)
    │  │                + TOOL_USE_CODE_EXAMPLES (for patterns)
    │  │                + QUICK_REFERENCE (for lookup)
    │
    ├─ I'm reviewing PRs → QUICK_REFERENCE (validation checklist)
    │  │                 + EXPLORATION_SUMMARY (key concepts)
    │
    └─ I'm optimizing → EXPLORATION_EXECUTIVE_SUMMARY (metrics)
                     + QUICK_REFERENCE (performance section)
                     + EXPLORATION_SUMMARY (performance notes)
```

---

## ✅ Document Checklist

Use this to verify which documents you've read:

- [ ] Read EXPLORATION_EXECUTIVE_SUMMARY.md (5-10 min investment for big picture)
- [ ] Skimmed QUICK_REFERENCE.md (1 min to know where to find things)
- [ ] Read MESSAGE_FLOW_DIAGRAM.md (understand data flow)
- [ ] Read EXPLORATION_SUMMARY.md (complete understanding)
- [ ] Read relevant TOOL_USE_CODE_EXAMPLES.md sections (for your task)
- [ ] Reviewed QUICK_REFERENCE.md Validation Checklist (before implementing)
- [ ] Used QUICK_REFERENCE.md for line number lookups (while coding)

---

## 🔗 Cross-References

### Common Questions & Where to Find Answers

**Q: How are tool_use blocks handled?**  
A: TOOL_USE_CODE_EXAMPLES (Examples 1-3), EXPLORATION_SUMMARY (Tool Use Block Detection)

**Q: What happens when a request overflows context?**  
A: TOOL_USE_CODE_EXAMPLES (Example 4), EXPLORATION_SUMMARY (Error Handling)

**Q: Where is the main fetch hook?**  
A: QUICK_REFERENCE (line 2299), EXPLORATION_SUMMARY (Fetch Interceptor)

**Q: What are the invariants for message arrays?**  
A: EXPLORATION_SUMMARY (Message Array Structure), QUICK_REFERENCE (Validation Checklist)

**Q: How does account switching work?**  
A: MESSAGE_FLOW_DIAGRAM (Account Selection & Retry Flow), EXPLORATION_EXECUTIVE_SUMMARY (Error Recovery)

**Q: What's the test coverage?**  
A: EXPLORATION_EXECUTIVE_SUMMARY (Test Coverage), QUICK_REFERENCE (Testing Quick Lookup)

**Q: How do I enable debug output?**  
A: QUICK_REFERENCE (Debug Logging), EXPLORATION_SUMMARY (Fetch Interceptor)

**Q: What environment variables affect behavior?**  
A: QUICK_REFERENCE (Env Variables), EXPLORATION_EXECUTIVE_SUMMARY (Configuration)

---

## 📊 Document Statistics

| Document             | Pages   | Sections | Tables | Examples | Diagrams |
| -------------------- | ------- | -------- | ------ | -------- | -------- |
| Executive Summary    | 15      | 12       | 8      | 0        | 0        |
| Exploration Summary  | 35      | 8        | 10     | 0        | 0        |
| Message Flow Diagram | 25      | 8        | 2      | 0        | 8        |
| Tool Use Examples    | 20      | 8        | 0      | 8        | 0        |
| Quick Reference      | 12      | 12       | 25     | 5        | 0        |
| **TOTAL**            | **107** | **48**   | **43** | **13**   | **8**    |

**Total exploration content:** ~107 pages (print equivalent), 12,000+ lines

---

## 🚀 How to Use These Documents

### Scenario 1: I'm New to This Codebase

1. Start with EXPLORATION_EXECUTIVE_SUMMARY (10 min)
2. Read QUICK_REFERENCE Quick Lookup tables (5 min)
3. Study MESSAGE_FLOW_DIAGRAM (15 min)
4. Read EXPLORATION_SUMMARY for deep dive (30 min)
5. **Total: ~1 hour** for complete understanding

### Scenario 2: I'm Implementing a Feature

1. Scan QUICK_REFERENCE for relevant code locations
2. Jump to EXPLORATION_SUMMARY sections on that topic
3. Review TOOL_USE_CODE_EXAMPLES for similar patterns
4. Check QUICK_REFERENCE Validation Checklist before submitting
5. **Total: 30-60 min** depending on complexity

### Scenario 3: I'm Debugging

1. Look up error in QUICK_REFERENCE Common Issues table
2. Jump to relevant code using line numbers
3. Review MESSAGE_FLOW_DIAGRAM for the failing stage
4. Check TOOL_USE_CODE_EXAMPLES if related to tool use
5. Use QUICK_REFERENCE Debug Logging section to enable logs
6. **Total: 5-30 min** depending on issue

### Scenario 4: I'm Reviewing a PR

1. Use QUICK_REFERENCE Validation Checklist
2. Cross-reference changes with EXPLORATION_SUMMARY sections
3. Check TOOL_USE_CODE_EXAMPLES for similar patterns
4. Verify error handling matches MESSAGE_FLOW_DIAGRAM
5. **Total: 15-45 min** depending on PR size

---

## 💡 Key Insights to Remember

1. **Message arrays must end with user message** — Never assistant
2. **Tool use requires tool result pairing** — Each tool_use must have tool_result
3. **mcp\_ prefix is for routing** — Added outbound, stripped inbound
4. **Error recovery has 3 levels** — Account switching → backoff → context trim
5. **SSE streaming is used** — Can't buffer entire response
6. **Signature emulation is complex** — Not just system prompt injection
7. **Account management is sophisticated** — Health scoring, token budgets, rate limits

---

## 🎓 Learning Path

**Beginner** (Want to understand the project)
→ EXPLORATION_EXECUTIVE_SUMMARY → QUICK_REFERENCE

**Intermediate** (Want to understand implementation)
→ EXPLORATION_SUMMARY → MESSAGE_FLOW_DIAGRAM

**Advanced** (Want to implement changes)
→ TOOL_USE_CODE_EXAMPLES → QUICK_REFERENCE (as reference)

**Expert** (Want deep knowledge)
→ All 5 documents, then read source code using line numbers

---

## 📞 Using These Documents in Code Comments

### Example: Documenting a function

```javascript
/**
 * Synthesize tool_result responses when message array ends with tool_use blocks.
 *
 * Context: The Anthropic API rejects message arrays that end with assistant messages
 * containing tool_use blocks (error: "assistant message prefill").
 *
 * Solution: Check if the last message is an assistant message with tool_use blocks.
 * If so, synthesize tool_result responses for each tool_use and append as a new
 * user message.
 *
 * Reference: EXPLORATION_SUMMARY.md § Tool Use Block Detection
 * Code location: index.mjs lines 6142-6151
 *
 * @param {Array} messages
 * @returns {void} Mutates messages array
 */
function synthesizeToolResults(messages) {
  // ... implementation ...
}
```

---

## 🔍 How to Find Things

### By Topic

Use the navigation flowchart above

### By Code Location

Use QUICK_REFERENCE.md tables

### By Example

Check TOOL_USE_CODE_EXAMPLES.md

### By Visual Diagram

Check MESSAGE_FLOW_DIAGRAM.md

### By Complete Reference

Check EXPLORATION_SUMMARY.md

### By Definition

Check QUICK_REFERENCE.md definitions & patterns

---

## ⚠️ Important Notes

1. **Line numbers are accurate as of the latest codebase**. If files change significantly, line numbers may shift.

2. **Code examples are simplified for clarity**. Real implementation may have additional error handling.

3. **Diagrams are ASCII art for compatibility**. Use online diagram tools for different visualizations.

4. **These are exploration documents**, not official project documentation. For official docs, see `docs/` in the project.

5. **Keep these documents updated** if the codebase changes significantly.

---

## 📝 Document Maintenance

**Last Updated:** [Current Date]  
**Project Version:** 0.0.41  
**Status:** Complete & Verified

If you find inaccuracies:

1. Check the actual code (line numbers may have shifted)
2. Note the section and issue
3. Update the document
4. Re-verify against latest codebase

---

## 🎉 You're All Set!

Pick a starting document based on your needs above and dive in. Happy exploring!
