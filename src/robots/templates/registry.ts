import { blocked, sameIdentity, veto } from './common';
import { trendFollowing } from './trend-following';
import { vwapMeanReversion } from './vwap-mean-reversion';
import { wickCapture } from './wick-capture';
import type { StrategyTemplate, TemplateInput, TemplateResult } from './types';

export const templates: readonly StrategyTemplate[] = [trendFollowing, wickCapture, vwapMeanReversion];

export function evaluateTemplate(input: TemplateInput): TemplateResult {
  const template = templates.find(value => sameIdentity(value.identity, input.approved.plan.template));
  return template ? template.evaluate(input)
    : blocked(input, veto('capability', 'unsupported_template_version', 'This strategy contract is unsupported. Explicit cutover is required.'));
}
