import type { RobotProposal } from '../domain';
export type ProposalDraft = Omit<RobotProposal, 'schemaVersion' | 'scope' | 'id' | 'revision' | 'opportunityKey'>;
