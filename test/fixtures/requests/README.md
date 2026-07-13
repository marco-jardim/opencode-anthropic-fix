# Request replay fixtures

These fixtures pair a captured Anthropic request with a deterministic scripted
SSE response. Tests replay them through the public plugin interceptor rather
than calling internal request or response transforms directly.

Generate a fixture from a request capture with:

```text
node scripts/capture-to-fixture.mjs <capturePath> [<responseSpecPath>] --out <fixturePath>
```

The converter applies `lib/redact.mjs` to the complete fixture before writing
it. Never hand-copy unredacted credentials, cookies, tokens, authorization
headers, or personal data into this directory.

Each JSON file has `meta`, `request`, and `response` objects. The response's
`sseChunks` entries are literal wire frames and include their trailing blank
line (`\n\n`).
