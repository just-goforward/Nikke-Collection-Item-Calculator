import { GAME_DAY_MS, gameDayKey } from "./gameDay.ts";

/** Public releases in ONE published slot, not claimable stock or a personal future total. */
export const PUBLIC_SUPPLY_PROJECTION_POLICY = "published-slot-releases-v1" as const;
export type PublicSupplyReference = Readonly<{
  publicationContentHash: string;
  projectionPolicyVersion: typeof PUBLIC_SUPPLY_PROJECTION_POLICY;
  gameDay: string;
  slotStart: string;
  slotEnd: string;
}>;

export const HASH = /^[a-f0-9]{64}$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?(?:Z|[+-]\d{2}:\d{2})$/;
export const iso = (time: number) => new Date(time).toISOString();

export function publicInstant(value: unknown): number {
  if (typeof value !== "string" || !TIMESTAMP.test(value) || !Number.isFinite(Date.parse(value)))
    throw new Error("invalid_public_supply_reference");
  return Date.parse(value);
}
export function dayStart(day: unknown): number {
  if (typeof day !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(day))
    throw new Error("invalid_public_supply_reference");
  const start = Date.parse(`${day}T05:00:00+09:00`);
  if (!Number.isFinite(start) || gameDayKey(start) !== day)
    throw new Error("invalid_public_supply_reference");
  return start;
}
export function parsePublicSupplyReference(value: unknown): PublicSupplyReference {
  const keys = ["publicationContentHash", "projectionPolicyVersion", "gameDay", "slotStart", "slotEnd"];
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).length !== keys.length || !keys.every(key => Object.hasOwn(value, key)))
    throw new Error("invalid_public_supply_reference");
  const raw = value as Record<string, unknown>;
  if (typeof raw["publicationContentHash"] !== "string" || !HASH.test(raw["publicationContentHash"]) ||
      raw["projectionPolicyVersion"] !== PUBLIC_SUPPLY_PROJECTION_POLICY)
    throw new Error("invalid_public_supply_reference");
  const start = dayStart(raw["gameDay"]);
  const from = publicInstant(raw["slotStart"]), until = publicInstant(raw["slotEnd"]);
  if (from < start || until > start + GAME_DAY_MS || from >= until)
    throw new Error("invalid_public_supply_reference");
  return {
    publicationContentHash: raw["publicationContentHash"],
    projectionPolicyVersion: PUBLIC_SUPPLY_PROJECTION_POLICY,
    gameDay: raw["gameDay"] as string,
    slotStart: iso(from),
    slotEnd: iso(until),
  };
}
