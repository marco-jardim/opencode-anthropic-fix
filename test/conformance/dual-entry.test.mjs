import { describe, expect, it } from "vitest";
import * as modern from "../../server.mjs";

describe("dual host entry contract", () => {
  it("exposes one definition to the modern loaders, with both lifecycle methods", () => {
    expect(Object.keys(modern)).toEqual(["default"]);
    expect(modern.default.id).toBe("opencode-anthropic-fix");
    expect(typeof modern.default.server).toBe("function");
    expect(typeof modern.default.setup).toBe("function");
  });
});
