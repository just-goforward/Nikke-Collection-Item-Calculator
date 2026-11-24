import { candidateAnalytics } from './root-candidate-analytics';
import { readPolicyPackage } from '../scripts/ci/hybrid-b-policy-package.mjs';

candidateAnalytics(async () => {
  return readPolicyPackage(process.env.ROOT_POLICY_CANDIDATE_DIR);
}, (suite, title, scenario) => suite(title, scenario));
