import type { FullConfig, FullResult, Reporter, Suite, TestCase, TestError, TestResult, TestStep } from "@playwright/test/reporter";
import { approvedId, DiagnosticStream, hasOutboundViolation, loadApproval, writeDiagnostic, writeSuite } from "./operational-report.mjs";

export default class OperationalReporter implements Reporter {
  private readonly approval;
  private readonly suiteId: string;
  private suite?: Suite;
  private invalid = false;
  private readonly globalErrors: unknown[] = [];
  private readonly stderr = new DiagnosticStream();
  private readonly stdout = new DiagnosticStream();
  private readonly clockSteps: unknown[] = [];
  constructor(options: { suiteId: string }) {
    this.suiteId = options.suiteId;
    this.approval = loadApproval(this.suiteId);
  }
  // Claim the console without writing it: false makes Playwright add a leaking default reporter.
  printsToStdio() { return true; }
  onStdOut(chunk: string | Buffer) { this.stdout.push(chunk); }
  onStdErr(chunk: string | Buffer) { this.stderr.push(chunk); }
  onError(error?: TestError) {
    this.invalid = true;
    if (this.globalErrors.length < 8) this.globalErrors.push(error ?? { message: "framework_error" });
  }
  onStepEnd(_test: TestCase, _result: TestResult, step: TestStep) {
    if (this.clockSteps.length < 128 && /clock|(?:fixed|system) time/i.test(step.title))
      this.clockSteps.push({ title: step.title, started: step.startTime.toISOString(), duration: step.duration });
  }
  onBegin(_config: FullConfig, suite: Suite) { this.suite = suite; }
  onTestEnd(_test: TestCase, _result: TestResult) {}
  async onEnd(result: FullResult): Promise<{ status: "passed" | "failed" }> {
    let complete = false;
    try {
      const tests = this.suite?.allTests() ?? [];
      writeDiagnostic(this.suiteId, [...tests.map(test => ({
        title: test.title.slice(0, 512),
        errors: test.results.flatMap(run => run.errors).slice(0, 8),
      })), { title: "framework", errors: this.globalErrors, stderr: this.stderr.text(),
        stdout: this.stdout.text(), clockSteps: this.clockSteps,
        streamOverflow: this.stderr.overflow || this.stdout.overflow }]);
      const cases = tests.map(test => ({
        id: approvedId(this.approval, test.location.file, test.title),
        status: test.results.at(-1)?.status ?? "interrupted",
        attempts: test.results.length,
      }));
      complete = writeSuite(this.suiteId, this.approval, cases,
        !this.invalid && !this.stderr.overflow && !this.stdout.overflow && result.status === "passed" &&
        (this.suiteId !== "production-policy" || !hasOutboundViolation()));
    } catch {
      // Never forward framework names, paths, errors or state to a public reporter.
      this.invalid = true;
    }
    return { status: complete && !this.invalid ? "passed" : "failed" };
  }
}
