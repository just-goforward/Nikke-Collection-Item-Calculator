// Proposed *additional* cases, not aliases for the operational inventory.
import { sha256 } from './hybrid-b-policy-package.mjs';

const analytics = [
  'enrolled disabled catalog boots without analytics transport',
  'verified WAIT and Current never emit decision telemetry',
  'unanswered recommendation is not restored after reload',
  'denied storage does not prevent verified calculation',
  'legacy personal records remain untouched by calculation',
  'theme alone persists across locale navigation and reload',
  'mobile unanswered Current and WAIT leave no durable state',
  'confirmed great success and conversion do not submit conditional outcomes',
  'confirmed normal batch settles real stock without analytics',
  'explicit batch attempt settles only actual use without analytics',
  'unknown batch attempt and stock correction remain private',
  'denied storage preserves reset and undo in RAM only',
];
const product = Array.from({length:9}, (_, i) => 'BP00' + (i+1));
export const inventories = {
  product: {suite:'product', project:'chromium', config:'playwright.hybrid-b-product.config.ts',
    spec:'e2e/hybrid-b-production.spec.ts', cases:product.map(id => ({id, title:id}))},
  analytics: {suite:'analytics', project:'chromium', config:'playwright.hybrid-b-analytics.config.ts',
    spec:'e2e/root-candidate-analytics.spec.ts', cases:analytics.map((title, i) => ({id:'BA' + String(i+1).padStart(3,'0'), title}))},
};
export function inventory(suite) {
  if (!Object.hasOwn(inventories, suite)) throw Error('unknown candidate policy suite');
  return inventories[suite];
}
export const inventoryDigest = suite => sha256(JSON.stringify(inventory(suite)));
