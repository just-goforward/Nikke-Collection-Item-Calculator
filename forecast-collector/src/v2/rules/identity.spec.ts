import { expect, it } from "vitest";
import {
  collaborationIdentity,
  excludedCollaborationTitle,
  grantIdentity,
  resolveMaintenance,
} from "./identity";

it("excludes every approved Pick Up spelling", () => {
  for (const title of ["Pick Up", "PICKUP", "pick up", "픽업"])
    expect(excludedCollaborationTitle(title)).toBe(true);
});
it("keeps undated collaboration posts as evidence and asks about different-start overlap", () => {
  expect(collaborationIdentity("콜라보", null, [])).toEqual({ action: "evidence" });
  const existing = [
    { id: "c", startAt: "2026-07-03T12:00:00+09:00", endAt: "2026-07-31T04:59:59+09:00" },
  ];
  expect(collaborationIdentity("콜라보", existing[0]!.startAt, existing)).toEqual({
    action: "link",
    eventId: "c",
  });
  expect(collaborationIdentity("콜라보", "2026-07-04T12:00:00+09:00", existing)).toMatchObject({
    action: "decision",
  });
});
it("does not guess missing or multiple same-date maintenance", () => {
  expect(resolveMaintenance("2026-07-03", [])).toEqual({ reason: "maintenance_missing" });
  const event = {
    id: "m1",
    startAt: "2026-07-03T05:00:00+09:00",
    endAt: "2026-07-03T12:00:00+09:00",
  };
  expect(resolveMaintenance("2026-07-03", [event])).toEqual({ eventId: "m1", endAt: event.endAt });
  expect(resolveMaintenance("2026-07-03", [event, { ...event, id: "m2" }])).toEqual({
    reason: "maintenance_multiple",
  });
});
it("deduplicates equal grants only on the same game day and asks about quantity conflicts", () => {
  const grant = { gameDay: "2026-08-22", ii: 10, box: 0 };
  const existing = [{ ...grant, id: "g" }];
  expect(grantIdentity(grant, existing)).toEqual({ action: "link", grantId: "g" });
  expect(grantIdentity({ ...grant, gameDay: "2026-08-23" }, existing)).toEqual({
    action: "create",
  });
  expect(grantIdentity({ ...grant, ii: 20 }, existing)).toMatchObject({
    action: "decision",
    reason: "grant_quantity",
  });
});
