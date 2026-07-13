import { createFakeAnthropic } from "./fake-anthropic.mjs";

/**
 * Install a FIFO-scripted Anthropic fetch replacement.
 *
 * @param {ReturnType<typeof createFakeAnthropic>} [fake]
 * @returns {ReturnType<typeof createFakeAnthropic> & { teardown: () => void }}
 */
export function installHttpMock(fake = createFakeAnthropic()) {
  const originalFetch = globalThis.fetch;
  let installed = true;

  globalThis.fetch = fake.fetch;

  return {
    ...fake,
    teardown() {
      if (!installed) return;
      globalThis.fetch = originalFetch;
      fake.reset();
      installed = false;
    },
  };
}

/**
 * Restore the fetch saved by installHttpMock().
 *
 * @param {{ teardown: () => void }} mock
 */
export function teardownHttpMock(mock) {
  mock.teardown();
}
