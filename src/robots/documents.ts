import type { Database } from '../core/database';
import type { RobotProposal } from './domain';
import type { ChronologicalReport, HoldoutExposure } from './research/chronological';
import { validateProposal } from './validation';
import { templates } from './templates/registry';
import { accountKey } from '../core/account';
import { validateChronologicalReport } from './research/report-validation';
import { validateOutcomeAssumptions, validateProspectiveOutcome, type OutcomeAssumptions, type ProspectiveCandidate, type ProspectiveOutcome } from './research/prospective-records';
import { instant, requireValue } from '../core/validation';

export interface ProposalEvidence {
  features: Pick<ProspectiveCandidate['features'], 'asOf' | 'priceUsd' | 'dailyLiquidityUsd'>;
  costs: OutcomeAssumptions;
  inputSymbols: number;
  testedConfigurations: number;
}
export interface ProposalDocument extends ProposalEvidence {
  key: string; scope: string; kind: 'proposal'; proposal: RobotProposal; dismissed: boolean; outcome: ProspectiveOutcome | null;
}
export interface ExperimentDocument {
  key: string; scope: string; kind: 'experiment'; id: string; exposure: readonly HoldoutExposure[]; report: ChronologicalReport | null;
}
export type ResearchDocument = ProposalDocument | ExperimentDocument;

function proposalDocument(value: unknown, scope: string): ProposalDocument {
  requireValue(value !== null && typeof value === 'object', 'research', 'damaged_proposal');
  const document = value as Record<string, unknown>;
  validateProposal(document.proposal, templates); validateOutcomeAssumptions(document.costs);
  requireValue(document.key === JSON.stringify([scope, document.proposal.id]) && document.scope === scope
    && accountKey(document.proposal.scope) === scope && document.kind === 'proposal' && typeof document.dismissed === 'boolean', 'research', 'damaged_scope');
  requireValue(document.features !== null && typeof document.features === 'object', 'research', 'damaged_features');
  const features = document.features as Record<string, unknown>;
  instant(features.asOf, 'features.asOf');
  requireValue(features.asOf <= document.proposal.generatedAt, 'research', 'future_features');
  const priceUsd = features.priceUsd, dailyLiquidityUsd = features.dailyLiquidityUsd;
  requireValue(typeof document.inputSymbols === 'number' && Number.isSafeInteger(document.inputSymbols) && document.inputSymbols >= 0
    && typeof document.testedConfigurations === 'number' && Number.isSafeInteger(document.testedConfigurations) && document.testedConfigurations >= 0, 'research', 'invalid_breadth');
  requireValue(priceUsd === null || typeof priceUsd === 'number' && Number.isFinite(priceUsd) && priceUsd > 0, 'research', 'invalid_price');
  requireValue(dailyLiquidityUsd === null || typeof dailyLiquidityUsd === 'number' && Number.isFinite(dailyLiquidityUsd) && dailyLiquidityUsd >= 0, 'research', 'invalid_liquidity');
  if (document.outcome !== null) {
    validateProspectiveOutcome(document.outcome);
    requireValue(document.outcome.candidateId === document.proposal.id && accountKey(document.outcome.scope) === scope, 'research', 'outcome_scope_mismatch');
  }
  return { key: String(document.key), scope, kind: 'proposal', proposal: document.proposal, dismissed: document.dismissed,
    features: { asOf: features.asOf, priceUsd, dailyLiquidityUsd }, costs: document.costs, outcome: document.outcome,
    inputSymbols: document.inputSymbols, testedConfigurations: document.testedConfigurations };
}

export class ResearchDocuments {
  constructor(private readonly db: Database, private readonly scope: string) {}
  async load(): Promise<ResearchDocument[]> {
    const rows = await this.db.getAllFromIndex('research', 'scope', this.scope);
    const result: ResearchDocument[] = [];
    for (const value of rows) {
      if (!value || typeof value !== 'object' || !('key' in value) || typeof value.key !== 'string' || !('kind' in value)) throw new Error('Research records are damaged; research is unavailable.');
      if (value.kind === 'proposal' && 'proposal' in value && 'dismissed' in value && typeof value.dismissed === 'boolean') {
        result.push(proposalDocument(value, this.scope));
      } else if (value.kind === 'experiment' && 'id' in value && typeof value.id === 'string' && 'exposure' in value && Array.isArray(value.exposure) && 'report' in value) {
        const exposure: HoldoutExposure[] = value.exposure.map(item => {
          if (!item || typeof item !== 'object' || typeof item.sourceRef !== 'string' || typeof item.tradingDate !== 'string') throw new Error('Research exposure is damaged.');
          instant(`${item.tradingDate}T00:00:00.000Z`, 'exposure.date');
          return { sourceRef: item.sourceRef, tradingDate: item.tradingDate };
        });
        const report = value.report;
        if (report !== null) validateChronologicalReport(report);
        requireValue(value.key === JSON.stringify([this.scope, value.id]), 'experiment', 'scope_mismatch');
        result.push({ key: value.key, scope: this.scope, kind: 'experiment', id: value.id, exposure, report });
      } else throw new Error('Unsupported research document.');
    }
    return result;
  }
  async saveProposal(proposal: RobotProposal, evidence?: ProposalEvidence, dismissed = false): Promise<void> {
    validateProposal(proposal, templates);
    const key = JSON.stringify([this.scope, proposal.id]);
    await this.db.update('research', key, saved => {
      if (saved) {
        const prior = proposalDocument(saved, this.scope);
        requireValue(JSON.stringify(prior.proposal) === JSON.stringify(proposal), 'research', 'proposal_is_immutable');
        return { ...prior, dismissed };
      }
      requireValue(evidence, 'research', 'missing_offer_evidence');
      return proposalDocument({ key, scope: this.scope, kind: 'proposal', proposal, dismissed, outcome: null,
        features: evidence.features, costs: evidence.costs, inputSymbols: evidence.inputSymbols, testedConfigurations: evidence.testedConfigurations }, this.scope);
    });
  }
  async saveOutcome(id: string, outcome: ProspectiveOutcome): Promise<void> {
    validateProspectiveOutcome(outcome);
    const key = JSON.stringify([this.scope, id]);
    await this.db.update('research', key, saved => proposalDocument({ ...proposalDocument(saved, this.scope), outcome }, this.scope));
  }
  async saveExperiment(id: string, exposure: readonly HoldoutExposure[], report: ChronologicalReport | null): Promise<void> {
    if (report) validateChronologicalReport(report);
    await this.db.put('research', { key: JSON.stringify([this.scope, id]), scope: this.scope, kind: 'experiment', id, exposure, report });
  }
}
