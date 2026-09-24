# `lean_prompt` in Claude Code 2.1.280: an inverted system-prompt switch

> ⚠️ **The prompt TEXT delta is UNKNOWN.** Nobody has extracted the text of
> either system prompt that this switch selects between. This document records
> _which_ prompt a model is routed to, not _what_ either prompt says. Nothing
> below describes, characterises or estimates the content or the length of the
> shorter prompt. The word "shorter", here and below, repeats the analysis
> document's reading of the capability's name and of the inverted return; no
> length was measured. See [§3](#3-unknown-the-prompt-text-delta).

> **Read the name backwards.** The upstream predicate that consults
> `lean_prompt` returns the answer to "send the **FULL**, verbose system
> prompt?". Its return is inverted relative to the capability's name:
>
> - a model that **carries** `lean_prompt` gets the **shorter** prompt;
> - a model that does **not** carry it is not routed through this capability
>   at all; the predicate's later branches decide instead: they select the
>   non-full prompt for `claude-mythos-5` (and for whatever `Ide()` matches),
>   the full prompt for the `claude-3-*`, haiku, sonnet and `opus-4-0` through
>   `opus-4-7` names, and an untranscribed fallback for every other id (see
>   §1).
>
> The word "lean" describes the prompt the holders receive, not the value the
> predicate returns.

## 1) The upstream predicate

The evidence is the 2.1.280 analysis document in the sibling repository (see
§5). It records the predicate at `[BIN]` byte `7850774` as `te()`:

```js
function te(e) {
  let n = Ge(e),
    r = Lm(n, "lean_prompt", e);
  if (r !== void 0) return !r;
  if (Ide(e) || n === "claude-mythos-5") return !1;
  if (
    n.includes("claude-3-") ||
    n.includes("haiku") ||
    n.includes("sonnet") ||
    n === "claude-opus-4-0" ||
    n === "claude-opus-4-1" ||
    n === "claude-opus-4-5" ||
    n === "claude-opus-4-6" ||
    n === "claude-opus-4-7"
  )
    return !0;
  return !al();
}
```

The analysis document's own reading, verbatim:

> Note the **inverted return**: `te()` answers "send the full, verbose system
> prompt". A model that _has_ `lean_prompt` gets the _shorter_ prompt.

The first branch is the one this document is about: when the `lean_prompt`
lookup yields a value, `te()` returns its negation, so a holder gets `false`
("do not send the full prompt"). That capability lookup is itself layered (an
environment variable, a remote lookup, then the static catalogue), so "holder"
here means a holder in the static catalogue absent those overrides; this is
separate from the `Bq()` override in §2.1. The later branches only run when
that lookup yields `undefined`. The analysis document does not characterise
`Ide()` or `al()`, so this document does not guess what they test. Note that
`claude-mythos-5` does not carry `lean_prompt` but is special-cased to
`return !1`, the same "not full" answer the holders get.

## 2) Holders in Claude Code 2.1.280

These model ids carry the `lean_prompt` capability in the 2.1.280 model
catalogue (analysis document §5.4):

- `claude-opus-4-8`
- `claude-opus-5`
- `claude-opus-5-5`
- `claude-fable-5`
- `claude-fable-5-1`
- `claude-mythos-5-1`

No other model id in that catalogue carries it.

### 2.1 A remote override exists

The capability string is **necessary but not sufficient** evidence of which
prompt a genuine client sends. The analysis document records a remote override:

> A remote override exists:
> `x2(e)=Bq()?n.leanPromptCompiledOnly(e):n.leanPrompt(e)`.

The analysis document does not name the remote feature gate or flag key behind
`Bq()`, and this document does not invent one. For this repository the
consequence is that a static reading of the catalogue cannot tell which prompt a
given account's client is actually sending on a given day.

## 3) UNKNOWN: the prompt text delta

**The text of the full prompt and the text of the shorter prompt were NOT
extracted.** The analysis document marks this `[UNR]` (unresolved):

> The **text** of the two prompts was not extracted `[UNR]`. The semantic
> reading of `te()` as "verbose" rests on the inverted return and the model
> list, not on a transcribed prompt string.

So even the word "verbose" is an inference from control flow, not a
transcription. What the shorter prompt omits, adds or rewords is unknown, and
nothing about its size is known either.

## 4) Why this matters to this repository

This plugin mimics Claude Code's system prompt (see
[`mimese-http-header-system-prompt.md`](./mimese-http-header-system-prompt.md)
§6). A genuine 2.1.280 client **selects** its system prompt by a mechanism this
plugin does not model, and whether either prompt it selects between matches the
one this plugin sends is unknown, for holder and non-holder models alike.

Any difference is currently **uncharacterised, so it cannot be mimicked**.
Until the text of both prompts is extracted from the binary, a request this
plugin sends to a holder model may differ from the genuine client's system
prompt in ways this repository cannot measure or reproduce. Treat any claim of
system-prompt parity for the holder models as unproven.

## 5) Evidence and scope

**Evidence.** The analysis document shipped in the npm package
`@tormentalabs/claude-code-wire-compat`, file
`docs/protocol/versions/claude-code-2.1.280-analysis.md`.
Search it for `lean_prompt`. §11.3 ("`lean_prompt` selects which system prompt
is sent") holds the predicate, the override and the `[UNR]` marker; §5.4 holds
the per-model capability arrays.

**Scope in the shared package.** `@tormentalabs/claude-code-wire-compat`
records this mechanism as **not ported**. Its `docs/source-trace.md` row for
"`lean_prompt` system-prompt selection" (category: system prompt authorship)
reads:

> Not ported. §11.3, search `selects which system prompt is sent`. It selects
> which system prompt the client sends; this package authors no system prompts
> and forwards the caller's verbatim. It is a real input-token lever upstream,
> so its absence matters to a caller who expected the client to choose for
> them.

The package forwards the caller's system prompt verbatim, so choosing the
prompt is this plugin's job, and so is the unresolved gap described in §3.
