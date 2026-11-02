import type { Reporter, TestModule } from "vitest/node";
import { approvedId, loadApproval, writeDiagnostic, writeSuite } from "./operational-report.mjs";

export default class OperationalReporter implements Reporter {
  private readonly approval = loadApproval("numerical-boundary");
  onTestRunEnd(modules: readonly TestModule[], errors: readonly unknown[], reason: string) {
    let complete = false;
    try {
      const tests = modules.flatMap(module => [...module.children.allTests()]);
      writeDiagnostic("numerical-boundary", [...tests.map(test => ({
        title: test.fullName.slice(0, 512),
        errors: (test.result().errors ?? []).slice(0, 8),
      })), { title: "framework", errors: errors.slice(0, 8) }]);
      const cases = tests.map(test => ({
        id: approvedId(this.approval, test.module.moduleId, test.fullName),
        status: test.result().state === "pending" ? "interrupted" : test.result().state,
        attempts: 1 + (test.diagnostic()?.retryCount ?? 0) + (test.diagnostic()?.repeatCount ?? 0),
      }));
      complete = writeSuite("numerical-boundary", this.approval, cases,
        reason === "passed" && errors.length === 0);
    } catch {
      complete = false;
    }
    if (!complete) process.exitCode = 1;
  }
}
