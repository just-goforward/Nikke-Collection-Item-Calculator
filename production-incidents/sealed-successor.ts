// One source-reviewed successor of this particular failed run; never derive a slot from caller input.
export const predecessorRun = '45184118767';
export const serviceBuild = 'd3fab41a90525df0c22b0a38541423d9bb23b8f33f7b47738811cea74bd3b701';
// SHA-256("incident-private-successor-v2:45184118767:1"), not a public service build.
export const successorBuild = '77d5dd2cd677a8ffc7ddf2540b3b58c125bb3d69d2d4d888f8cb5d93d6132d62';
// The old journal brackets insertion between arm-intent and observation of blocked/1.
const seal = `EXISTS(SELECT 1 FROM incidents i JOIN notifications n ON n.day=i.seen/86400
  AND n.build=i.build AND n.reason=i.reason AND n.stage=i.stage
  WHERE i.fingerprint='operator-private-canary' AND i.build='${serviceBuild}' AND i.reason='canary'
  AND i.stage='private' AND i.seen BETWEEN 1795441675 AND 1795442443
  AND n.state='blocked' AND n.attempts=1 AND n.next-i.seen>=3600)`;
const pristine = `(SELECT count(*) FROM incidents)=1 AND (SELECT count(*) FROM notifications)=1 AND ${seal}`;
const successor = `build='${successorBuild}' AND reason='canary' AND stage='private'`;
// No trigger/incident insertion, public drain, retention, or intermediate pending state.
// RETURNING grants the winning isolate the only capability to POST. Even another day cannot win.
export const claimSuccessor = `INSERT INTO notifications(day,build,reason,stage,state,attempts,next)
  SELECT unixepoch()/86400,'${successorBuild}','canary','private','claimed',1,unixepoch()
  WHERE ${pristine} AND unixepoch()>=?-3600 AND unixepoch()<?
  RETURNING day,build,reason,stage,attempts`;
// D1 numeric parameters can be SQLite REAL. Use integer UTC-day division for both bindings.
const permitDay = `day BETWEEN (CAST(? AS INTEGER)-3600)/86400 AND (CAST(? AS INTEGER)-1)/86400`;
// A crash after the committed claim is ambiguous. Only the new slot can be quarantined.
export const quarantineSuccessor = `UPDATE notifications SET state='uncertain' WHERE ${successor}
  AND state='claimed' AND attempts=1 AND next<unixepoch()-600 AND ${seal}
  AND ${permitDay}`;
export const successorSummary = `SELECT (SELECT count(*) FROM incidents) AS incidents,
  (SELECT count(*) FROM notifications) AS notifications, ${seal} AS sealed,
  (SELECT state FROM notifications WHERE ${successor} AND ${permitDay}) AS state,
  (SELECT attempts FROM notifications WHERE ${successor} AND ${permitDay}) AS attempts`;
