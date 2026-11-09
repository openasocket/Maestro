import type { Theme } from '../../types';
import type { RegisteredRepository, SymphonyIssue } from '../../../shared/symphony-types';
import type { AgentCommitRefusal } from '../../services/agentCommit';

/** What the repository steps (clone, branch, documents, draft PR) came to. */
export interface SymphonyRepositoryStart {
	success: boolean;
	contributionId?: string;
	branchName?: string;
	autoRunPath?: string;
	draftPrNumber?: number;
	draftPrUrl?: string;
	error?: string;
}

export interface SymphonyContributionData {
	/**
	 * The repository steps, run by the handler only AFTER the host admitted the
	 * agent, with that agent's id (MCOMP-23-04D). A refused agent therefore
	 * clones, forks and claims nothing. Absent: the contribution already started,
	 * and `contributionId` and the fields after it describe it.
	 */
	startRepository?: (sessionId: string) => Promise<SymphonyRepositoryStart>;
	contributionId?: string;
	localPath: string;
	autoRunPath?: string;
	branchName?: string;
	draftPrNumber?: number;
	draftPrUrl?: string;
	agentType: string;
	sessionName: string;
	repo: RegisteredRepository;
	issue: SymphonyIssue;
	customPath?: string;
	customArgs?: string;
	customEnvVars?: Record<string, string>;
	/**
	 * The policy revision the creation dialog's approved choices were read from
	 * (null standalone), so the host can answer `stale` for an agent built from an
	 * older policy (MCOMP-23-04B). Absent: the caller sent none.
	 */
	expectedPolicyRevision?: number | null;
}

/**
 * What starting a contribution's agent came to. A refusal by the host commit
 * carries the refusal, so the creation dialog keeps its draft and shows the
 * reasons by field. A handler that resolves nothing reported its own outcome.
 */
export type SymphonyContributionOutcome =
	| { ok: true }
	| { ok: false; error: string; refusal?: AgentCommitRefusal };

export interface SymphonyModalProps {
	theme: Theme;
	isOpen: boolean;
	onClose: () => void;
	onStartContribution: (
		data: SymphonyContributionData
	) => void | Promise<SymphonyContributionOutcome | void>;
	onSelectSession: (sessionId: string) => void;
}

export type ModalTab = 'projects' | 'active' | 'history' | 'stats';

export const SYMPHONY_TABS: readonly ModalTab[] = ['projects', 'active', 'history', 'stats'];
