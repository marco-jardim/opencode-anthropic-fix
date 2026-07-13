# Golden outgoing request

`outgoing-foreground.json` is the Wave 3 byte-shape regression guard for extracting the outgoing request transforms from `index.mjs`. The conformance test drives the real plugin interceptor and compares its normalized headers and parsed JSON body with this committed fixture.

To regenerate it, run `npx vitest run golden-outgoing`, capture the normalized object reported by the temporary calibration output, and replace the fixture only after reviewing every changed deterministic field. If a newly generated value appears, compare two fresh interceptor runs, add only the differing JSON path to `NORMALIZED_PATHS` with an explanation, and store `"<normalized>"` at that path. Never normalize stable mimicry fields to make a drift pass.
