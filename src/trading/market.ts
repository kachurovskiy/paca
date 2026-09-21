export { freshQuote } from '../core/quote';
import type { ExecutionQuote } from '../core/quote';
import type { TemplateInput } from '../robots/templates/types';
import type { RobotProposal } from '../robots/domain';
export interface ExecutionMarket {
  /** Reads current facts directly, independently of throttled UI publication. */
  quote(symbol: string): ExecutionQuote | null;
  ready(): boolean;
  snapshot(plan: RobotProposal): Promise<TemplateInput['market']>;
}
