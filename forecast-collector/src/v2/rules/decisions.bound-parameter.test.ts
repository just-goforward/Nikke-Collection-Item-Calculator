import { applyD1Migrations, reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, expect, it } from "vitest";
import { executeTestSql } from "../../../../shared/testD1Sql";
import schema from "../../test-schema";

/**
 * The environment fact the maintenance lookahead must respect, measured on real D1:
 * a statement may bind at most 100 parameters. Kept separate from the batch spec
 * (decisions.maintenance-grants.spec.ts, Node/SQLite lane) so the budget rule is
 * documented where it is actually enforced, at a cost of one cheap range query.
 */
beforeEach(async () => {
  await reset();
  await executeTestSql(env.FORECAST_DB, schema, applyD1Migrations);
});

it("rejects more than 100 bound parameters and accepts exactly 100", async () => {
  const db = env.FORECAST_DB;
  const statement = (parameters: number) =>
    `SELECT COUNT(*) AS n FROM (SELECT 1 WHERE 1 IN (${Array.from({ length: parameters }, () => "?").join(",")}))`;
  // Exactly at the limit is accepted...
  await expect(
    db
      .prepare(statement(100))
      .bind(...Array(100).fill(1))
      .first(),
  ).resolves.toEqual({
    n: 1,
  });
  // ...and one more is refused, so one placeholder per removed link id cannot scale.
  await expect(
    db
      .prepare(statement(101))
      .bind(...Array(101).fill(1))
      .first(),
  ).rejects.toThrow(/too many SQL variables/);
});
