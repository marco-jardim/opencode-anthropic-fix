/**
 * Convert a request capture into a redacted replay fixture.
 *
 * Usage:
 *   node scripts/capture-to-fixture.mjs <capturePath> [<responseSpecPath>] --out <fixturePath>
 */
import { readFileSync } from "node:fs";
import { basename, resolve } from "node:path";

import { buildFixtureFromCapture, writeFixture } from "../test/helpers/replay.mjs";

const DEFAULT_SSE_CHUNKS = [
  'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_fixture","type":"message","role":"assistant","model":"claude-haiku-4-5","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":1,"output_tokens":0}}}\n\n',
  'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":"","signature":""}}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"fixture thought"}}\n\n',
  'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
  'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_fixture","name":"mcp_write_file","input":{}}}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"path\\":\\"fixture.txt\\",\\"content\\":\\"ok\\"}"}}\n\n',
  'event: content_block_stop\ndata: {"type":"content_block_stop","index":1}\n\n',
  'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use","stop_sequence":null},"usage":{"output_tokens":12}}\n\n',
  'event: message_stop\ndata: {"type":"message_stop"}\n\n',
];

function usageError() {
  throw new Error("Usage: node scripts/capture-to-fixture.mjs <capturePath> [<responseSpecPath>] --out <fixturePath>");
}

const args = process.argv.slice(2);
const outIndex = args.indexOf("--out");
if (outIndex < 0 || !args[outIndex + 1] || outIndex > 2 || outIndex === 0) usageError();

const positional = args.slice(0, outIndex);
if (positional.length < 1 || positional.length > 2 || args.length !== outIndex + 2) usageError();

const capturePath = resolve(positional[0]);
const responseSpecPath = positional[1] ? resolve(positional[1]) : null;
const outPath = resolve(args[outIndex + 1]);
const capture = JSON.parse(readFileSync(capturePath, "utf8"));
const responseSpec = responseSpecPath
  ? JSON.parse(readFileSync(responseSpecPath, "utf8"))
  : {
      status: 200,
      headers: { "content-type": "text/event-stream" },
      sseChunks: DEFAULT_SSE_CHUNKS,
    };

const fixture = buildFixtureFromCapture(capture, responseSpec, {
  name: basename(outPath, ".json"),
  source: capture.label ?? basename(capturePath),
  createdAt: capture.timestamp ?? new Date().toISOString(),
  note: "Recorded request paired with an authored deterministic SSE response.",
});

writeFixture(outPath, fixture);
console.log(outPath);
