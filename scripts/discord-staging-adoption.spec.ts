import { describe, expect, it, vi } from "vitest";
import {
  assertResearchCertificateForecastCoverage,
  buildDiscordStagingAdoptionMessage,
  parseResearchCertificate,
  sendDiscordStagingAdoption,
} from "./discord-staging-adoption";

const review = {
  version: 1 as const,
  candidateId: "forecast-staging-adoption-12345678",
  forecastId: "supply-2026-08-28-v1",
  x: {
    status: "unavailable" as const,
    source: "jina" as const,
    reason: "rate_limited" as const,
    statusUrl: "https://x.com/NIKKE_kr/status/123456789",
  },
  schedule: {
    status: "estimated" as const,
    soloStart: "2026-09-17T03:00:00.000Z",
    soloEnd: "2026-09-23T19:59:00.000Z",
    collaborationPeriods: [],
  },
};

const research = {
  profileCount: 80,
  evaluatedProfileCount: 45,
  duplicateProfileCount: 35,
  baselineCandidateId: "H0.75-p3" as const,
  solverWasmSha256: "a".repeat(64),
};

describe("Discord staging forecast adoption", () => {
  it("uses a formal staging-only message and does not imply production approval", () => {
    const message = buildDiscordStagingAdoptionMessage(
      {
        approvalId: "discord-staging-00000000-0000-0000-0000-000000000000",
        customId: "forecast_staging_approve:discord-staging-00000000-0000-0000-0000-000000000000",
        forecastId: review.forecastId,
        sourcePullRequestUrl:
          "https://github.com/just-goforward/Nikke-Collection-Item-Calculator/pull/13",
        researchRunUrl:
          "https://github.com/just-goforward/Nikke-Collection-Item-Calculator/actions/runs/33287505614",
        expiresAt: "2026-08-31T00:00:00.000Z",
      },
      { review, research },
    );

    expect(message.content).toContain("승인 요청입니다");
    expect(message.content).toContain("45개 고유 gain vector");
    expect(message.content).toContain("production 사이트의 active forecast는 변경되지 않습니다");
    expect(message.components[0]?.components[0]).toMatchObject({
      label: "staging 적용 승인",
      style: 3,
    });
  });

  it("registers before posting the Discord button", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({
          approvalId: "discord-staging-00000000-0000-0000-0000-000000000000",
          customId: "forecast_staging_approve:discord-staging-00000000-0000-0000-0000-000000000000",
          forecastId: review.forecastId,
          sourcePullRequestUrl:
            "https://github.com/just-goforward/Nikke-Collection-Item-Calculator/pull/13",
          researchRunUrl:
            "https://github.com/just-goforward/Nikke-Collection-Item-Calculator/actions/runs/33287505614",
          expiresAt: "2026-08-31T00:00:00.000Z",
        }),
      )
      .mockResolvedValueOnce(Response.json({ id: "987654321" }));

    const result = await sendDiscordStagingAdoption(input(), fetcher);

    expect(result.messageId).toBe("987654321");
    expect(fetcher.mock.calls[0]?.[0]).toBe(
      "https://collector.example/admin/discord-staging-adoptions",
    );
    expect(fetcher.mock.calls[1]?.[0]).toBe(
      "https://discord.com/api/v10/channels/123456789/messages",
    );
  });

  it("accepts only a complete research-only baseline certificate", () => {
    expect(parseResearchCertificate(certificate())).toEqual(research);
    expect(() =>
      parseResearchCertificate({
        ...certificate(),
        decisionScope: { researchOnly: true, productAdoptionAuthorized: true },
      }),
    ).toThrow("scope is invalid");
  });

  it("requires complete target forecast coverage while allowing synthetic evidence profiles", () => {
    const summary = {
      ...certificate(),
      profiles: [
        {
          evidenceForecastProfileIds: [
            "supply-2026-08-28-v1@2026-08-28T20:00:00.000Z",
            "supply-2026-01-29-v1@2026-01-29T20:00:00.000Z",
          ],
        },
        {
          evidenceForecastProfileIds: ["supply-2026-08-28-v1@2026-08-29T20:00:00.000Z"],
        },
      ],
    };
    const expected = [
      "supply-2026-08-28-v1@2026-08-28T20:00:00.000Z",
      "supply-2026-08-28-v1@2026-08-29T20:00:00.000Z",
    ];

    expect(() =>
      assertResearchCertificateForecastCoverage(summary, review.forecastId, expected),
    ).not.toThrow();
    expect(() =>
      assertResearchCertificateForecastCoverage(summary, review.forecastId, expected.slice(0, 1)),
    ).toThrow("does not cover");
  });
});

function input() {
  return {
    collectorUrl: "https://collector.example",
    collectorAdminToken: "admin",
    discordBotToken: "bot",
    discordChannelId: "123456789",
    review,
    sourcePullRequestNumber: 13,
    sourcePullRequestUrl:
      "https://github.com/just-goforward/Nikke-Collection-Item-Calculator/pull/13",
    sourceHeadSha: "b".repeat(40),
    registrySha: "c".repeat(40),
    researchRunId: 33287505614,
    researchRunUrl:
      "https://github.com/just-goforward/Nikke-Collection-Item-Calculator/actions/runs/33287505614",
    researchArtifactName: "dynamic-hp-exact-gate-summary-33287505614",
    researchArtifactDigest: "d".repeat(64),
    research,
    runId: "100",
    runAttempt: "1",
  };
}

function certificate() {
  return {
    kind: "dynamic-hp-exact-gate-summary",
    version: 2,
    decisionScope: { researchOnly: true, productAdoptionAuthorized: false },
    profileCount: 80,
    evaluatedProfileCount: 45,
    duplicateProfileCount: 35,
    allProfilesComplete: true,
    certificate: { solverWasmSha256: "a".repeat(64) },
    candidates: [
      {
        candidateId: "H0.75-p3",
        status: "passed_all_profiles",
        exactPassed: 45,
        exactFailed: 0,
        exactIncomplete: 0,
      },
    ],
  };
}
