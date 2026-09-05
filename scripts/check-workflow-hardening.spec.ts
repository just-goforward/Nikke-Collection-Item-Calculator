import { describe, expect, it } from "vitest";

import { validateWorkflowSource } from "./check-workflow-hardening";

const PINNED_SHA = "3d3c42e5aac5ba805825da76410c181273ba90b1";

describe("validateWorkflowSource", () => {
  it("accepts pinned external actions, local actions, and bounded jobs", () => {
    const source = `jobs:
  verify:
    runs-on: ubuntu-latest
    timeout-minutes: 20
    steps:
      - uses: actions/checkout@${PINNED_SHA} # v7
      - uses: ./local-action
`;

    expect(validateWorkflowSource(source)).toEqual([]);
  });

  it("rejects floating external action references", () => {
    const source = `jobs:
  verify:
    runs-on: ubuntu-latest
    timeout-minutes: 20
    steps:
      - uses: actions/checkout@v7
`;

    expect(validateWorkflowSource(source)).toEqual([
      {
        line: 6,
        message: 'external action "actions/checkout@v7" must use a full 40-character commit SHA',
      },
    ]);
  });

  it("rejects runnable jobs without a timeout", () => {
    const source = `jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - run: npm test
`;

    expect(validateWorkflowSource(source)).toEqual([
      { line: 2, message: 'job "verify" is missing timeout-minutes' },
    ]);
  });

  it("requires immutable Docker digests", () => {
    const source = `jobs:
  container-check:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: docker://alpine:3.22
`;

    expect(validateWorkflowSource(source)).toEqual([
      {
        line: 6,
        message: 'external Docker action "docker://alpine:3.22" must use a sha256 digest',
      },
    ]);
  });

  it("does not require unsupported timeouts on reusable workflow call jobs", () => {
    const source = `jobs:
  delegated:
    uses: ./.github/workflows/reusable.yml
`;

    expect(validateWorkflowSource(source)).toEqual([]);
  });
});
