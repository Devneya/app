function skippedTests(testModules) {
  const violations = [];
  for (const module of testModules) {
    for (const test of module.children.allTests()) {
      const state = test.result().state;
      if (state === "skipped" || state === "pending") {
        violations.push(`${module.relativeModuleId}: ${test.fullName} (${state})`);
      }
    }
  }
  return violations;
}

export default class NoSkippedTestsReporter {
  onTestRunEnd(testModules, _unhandledErrors, reason) {
    const violations = skippedTests(testModules);
    if (testModules.length === 0) {
      globalThis.process.stderr.write("No Vitest modules were executed; verification is incomplete.\n");
      globalThis.process.exitCode = 1;
      return;
    }
    if (violations.length > 0) {
      globalThis.process.stderr.write(
        `Skipped or otherwise unexecuted Vitest tests are failures (run ${reason}):\n` +
          violations.map((item) => `- ${item}`).join("\n") +
          "\n",
      );
      globalThis.process.exitCode = 1;
    }
  }
}
