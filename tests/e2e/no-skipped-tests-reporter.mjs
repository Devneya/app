export default class NoSkippedTestsReporter {
  constructor() {
    this.expectedSkipped = [];
    this.skipped = [];
    this.testCount = 0;
  }

  onBegin(_config, suite) {
    const tests = suite.allTests();
    this.testCount = tests.length;
    this.expectedSkipped = tests
      .filter((test) => test.expectedStatus === "skipped")
      .map((test) => test.titlePath().join(" > "));
  }

  onTestEnd(test, result) {
    if (result.status === "skipped") {
      this.skipped.push(test.titlePath().join(" > "));
    }
  }

  onEnd(result) {
    const violations = [...new Set([...this.expectedSkipped, ...this.skipped])];
    if (this.testCount === 0) {
      globalThis.process.stderr.write("No Playwright tests were collected; verification is incomplete.\n");
      return { status: "failed" };
    }
    if (violations.length > 0) {
      globalThis.process.stderr.write(
        "Skipped or otherwise unexecuted Playwright tests are failures:\n" +
          violations.map((item) => `- ${item}`).join("\n") +
          "\n",
      );
      return { status: "failed" };
    }
    return { status: result.status };
  }

  printsToStdio() {
    return false;
  }
}
