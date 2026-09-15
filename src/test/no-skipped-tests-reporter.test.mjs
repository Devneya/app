import { afterEach, describe, expect, it } from "vitest";
import Reporter from "./no-skipped-tests-reporter.mjs";

const moduleFor = (state) => ({
  relativeModuleId: "synthetic.test.mjs",
  children: { allTests: () => [{ fullName: "synthetic test", result: () => ({ state }) }] },
});

describe("no-skipped-tests reporter", () => {
  const reporter = new Reporter();
  afterEach(() => {
    globalThis.process.exitCode = 0;
  });

  it("fails a skipped or pending test", () => {
    reporter.onTestRunEnd([moduleFor("skipped")], [], "passed");
    expect(globalThis.process.exitCode).toBe(1);
  });

  it("fails an empty run", () => {
    reporter.onTestRunEnd([], [], "passed");
    expect(globalThis.process.exitCode).toBe(1);
  });

  it("leaves a completed run successful", () => {
    reporter.onTestRunEnd([moduleFor("passed")], [], "passed");
    expect(globalThis.process.exitCode).toBe(0);
  });
});
