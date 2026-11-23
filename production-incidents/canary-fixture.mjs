import {serviceBuild} from './sealed-successor.ts';

// Synthetic timestamp within the preserved run's journal window, not a production dump.
export const seen=1795442401;
export const seedSeal=`INSERT INTO incidents VALUES('operator-private-canary',${seen},'${serviceBuild}','canary','private');
UPDATE notifications SET state='blocked',attempts=1,next=${seen+3600} WHERE build='${serviceBuild}';`;
export const oldEvidence=`SELECT i.*,n.day,n.state,n.attempts,n.next FROM incidents i JOIN notifications n
  ON n.build=i.build AND n.day=i.seen/86400 AND n.reason=i.reason AND n.stage=i.stage
  WHERE i.fingerprint='operator-private-canary'`;
