import { MEAN_REVERSION_POLICY } from '../research/mean-reversion';
import { vwapMeanReversion } from '../templates/vwap-mean-reversion';
import { canonicalSerialize } from '../research/values';
import type { RobotProposal, VersionedIdentity } from '../domain';
import { TREND_RESEARCH_POLICY } from '../research/trend';
import { WICK_RESEARCH_POLICY } from '../research/wick';
import { trendFollowing } from '../templates/trend-following';
import { wickCapture } from '../templates/wick-capture';
import { requireValue } from '../../core/validation';
import { validateForecastEvidence } from '../validation';
import { FORECAST_POLICY } from '../research/forecast-policy';

function admittedForecast(plan: RobotProposal): boolean {
  if (plan.forecast.status === 'unavailable') return true;
  if (plan.forecast.status !== 'experimental' || !plan.forecastEvidence || plan.forecast.model.id !== FORECAST_POLICY.id
    || plan.forecast.model.version !== FORECAST_POLICY.version) return false;
  try { validateForecastEvidence(plan); return true; } catch { return false; }
}

export const templatePolicies = [
  { template: trendFollowing, research: TREND_RESEARCH_POLICY, provenance: 'simulation' },
  { template: wickCapture, research: WICK_RESEARCH_POLICY, provenance: 'shadow' },
  { template: vwapMeanReversion, research: MEAN_REVERSION_POLICY, provenance: 'simulation' },
] as const;
export function templatePolicy(identity: VersionedIdentity) {
  const policy = templatePolicies.find(row => canonicalSerialize(row.template.identity) === canonicalSerialize(identity));
  requireValue(policy, 'templatePolicy', 'template_not_admitted');
  return policy!;
}
/** Registry presence alone grants no execution permission. */
export function admittedPlanTemplate(plan: RobotProposal) {
  const policy = templatePolicy(plan.template), equal = (a: unknown, b: unknown) => canonicalSerialize(a) === canonicalSerialize(b);
  requireValue(equal(plan.executionPolicy, policy.template.executionPolicy) && equal(plan.exitPolicy, policy.template.exitPolicy)
    && equal(plan.evidence.policy, { id: policy.research.id, version: policy.research.version })
    && plan.evidence.status === 'experimental' && plan.evidence.provenance === policy.provenance
    && plan.evidence.limitations.length > 0 && admittedForecast(plan), 'templatePolicy', 'evidence_policy_not_admitted');
  policy.template.validateParameters(plan.parameters);
  if (policy.template.identity.id === 'wick-capture') requireValue(WICK_RESEARCH_POLICY.settings.some(setting =>
    equal(setting, plan.parameters)), 'templatePolicy', 'wick_settings_not_admitted');
  if (policy.template.identity.id === 'vwap-mean-reversion') requireValue(MEAN_REVERSION_POLICY.configurations.some(setting =>
    equal(setting.parameters, plan.parameters)), 'templatePolicy', 'vwap_settings_not_admitted');
  return policy.template;
}
