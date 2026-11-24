// Obligation crosswalk, not an approval table. Preserve legacy IDs/receipts and their semantics.
import legacy from '../../e2e/operational-inventory.json' with {type:'json'};
import {approvedNames} from '../../e2e/operational-case-map.mjs';

const product = {
  P001:['BP001','Korean startup and calculation; original worker contract differs.'],
  P002:['BP002','English startup and calculation; original worker contract differs.'],
  P003:['BP003','Japanese startup and calculation; original worker contract differs.'],
  P004:['BP004','Compare theme-only persistence, URL language switch, and all reset fields.'],
  P005:['BP005','Compare denied-storage confirmation, RAM transition and complete reload inventory.'],
  P006:['BP006','Configured GET failure is not the original unconfigured stats branch.'],
  P007:['BP007','Compare seeded storage/account/locale and terminal no-worker assertions.'],
  P008:['BP008','Compare missing WASM refusal, exact worker count and no stock mutation.'],
};
const analytics = [
  ['A001 A002 A003 A004 A005 A006 A008 A009 A010 A011 A012', ['BA002','BA007'], 'No enabled episode observer for lazy/hidden/replaced Current and WAIT.'],
  ['A007',['BA007','BP002'],'Check actual 375px inventory/card bounds and WAIT timestamp. Hybrid keeps a non-actionable metric slot rather than removing its card.'],
  ['A013',[],'Disabled integration cannot distinguish an unrelated final callout from a suppressed valid episode.'],
  ['A014 A015 A016',[],'Need deterministic error/limit/cancellation after a retained checkpoint.'],
  ['A017 A018 A019',[],'Need deterministic restore/forecast/unmount during deferred cleanup.'],
  ['A020 A021 A022 A023',['BA008','BA009','BA010','BA011'],'No observed old-run attribution, controlled follow-up failure or separated attempt count.'],
  ['A024 A025',[],'Need stale callback and normalized edit episode ownership observations.'],
  ['A026',['BA009','BA010','BA011'],'Confirmed follow-up UI is not an acquisition episode receipt.'],
  ['A027',['BA008'],'R15 conversion UI is not an accepted SR5 episode count.'],
  ['A028',['BA001','BA002'],'No differential OFF/unconfigured resource comparison against App baseline.'],
  ['A029',['BA005'],'Preservation is not a forced legacy account initialization control.'],
  ['A030',['BA004','BA012'],'Denied calculation, confirmation, conversion, reset/undo and fresh-document inventory; prove the historical pending queue is unreachable under conditional-only stats.'],
  ['A031',['BA006','BP004'],'Proposed direct theme/locale/reload port; verify complete case on a genuine package and review equivalence.'],
  ['A032',['BA001'],'Actual package local layout, no solver at boot. The Vite devclient suppression was a specific historical fixture control.'],
  ['A033',[],'Disabled target cannot exercise Turnstile reset/execute or token reuse.'],
  ['A034',[],'Disabled transport is not failure isolation of an active production port.'],
  ['A035 A036',['BA008','BA009'],'Stock settlement is not a pre-mutation enabled v4 wire.'],
  ['A037 A038',[],'Need enabled same-ID retry and retained-Current cleanup/admission observations.'],
  ['A039 A040',['BA010','BA011'],'Actual/null attempt UI does not prove original terminal report identity.'],
  ['A041',['BA008','BA009','BA010','BA011'],'No send is not the historical legacy-only route; explicit reviewed applicability decision needed.'],
  ['A042',['BA003','BA007'],'Mobile RAM-only reload is not a pending v4 queue observation.'],
  ['A043',['BA011'],'Private stock correction does not prove patch identity or logged attempt.'],
  ['A044',[],'Disabled catalog does not test saturation of an enabled 20-report RAM queue.'],
];
export function coverage() {
  const obligations = legacy.suites['production-policy'].map(id => {
    const [related,remaining] = product[id];
    return {id,related:[related],disposition:'blocking-port-or-review',remaining};
  });
  for (const [i,id] of legacy.suites['analytics-policy'].entries()) {
    const requirement = approvedNames['analytics-policy'][i];
    const rows = analytics.filter(([ids]) => ids.split(' ').includes(id));
    if (rows.length !== 1) throw Error('missing or ambiguous legacy obligation: ' + id);
    const [,related,remaining] = rows[0];
    obligations.push({id,requirement,related,disposition:'blocking-port-or-review',remaining});
  }
  return obligations;
}
