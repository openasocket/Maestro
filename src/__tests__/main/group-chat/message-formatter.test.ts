/**
 * @fileoverview Tests for message-formatter.ts
 *
 * Tests contract-based message formatting for downstream agents
 * and moderator synthesis context.
 */

import { describe, it, expect } from 'vitest';
import {
	formatAgentInput,
	formatSynthesisContext,
} from '../../../main/group-chat/message-formatter';
import type { TeamTemplateRole, WorkflowTopology } from '../../../shared/group-chat-types';

describe('formatAgentInput', () => {
	const baseRole: TeamTemplateRole = {
		name: 'Reviewer',
		agentId: 'claude-code',
		description: 'Reviews code',
	};

	const upstreamOutputs = [
		{ roleName: 'Implementer', output: 'Implemented the feature with tests.' },
		{ roleName: 'Researcher', output: 'Found relevant documentation.' },
	];

	describe('when no contracts defined', () => {
		it('should return user message when no upstream outputs', () => {
			const result = formatAgentInput(baseRole, [], 'Please review this code');
			expect(result).toBe('Please review this code');
		});

		it('should return concatenated outputs with user message', () => {
			const result = formatAgentInput(baseRole, upstreamOutputs, 'Review this');
			expect(result).toContain('Review this');
			expect(result).toContain('[From Implementer]');
			expect(result).toContain('Implemented the feature with tests.');
			expect(result).toContain('[From Researcher]');
			expect(result).toContain('Found relevant documentation.');
		});
	});

	describe('when contracts are defined', () => {
		const roleWithContracts: TeamTemplateRole = {
			...baseRole,
			inputContract: ['Code changes to review'],
			outputContract: ['Review comments', 'Approval or rejection'],
		};

		it('should format with structured context', () => {
			const result = formatAgentInput(
				roleWithContracts,
				upstreamOutputs,
				'Review the implementation'
			);
			expect(result).toContain('## Task Context');
			expect(result).toContain('### Original Request');
			expect(result).toContain('Review the implementation');
			expect(result).toContain('### From Implementer:');
			expect(result).toContain('### From Researcher:');
			expect(result).toContain('## Your Assignment');
			expect(result).toContain('- [ ] Review comments');
			expect(result).toContain('- [ ] Approval or rejection');
		});

		it('should filter upstream by topology edges when topology provided', () => {
			const topology: WorkflowTopology = {
				pattern: 'pipeline',
				entryPoint: 'Implementer',
				exitPoint: 'Reviewer',
				edges: [{ source: 'Implementer', target: 'Reviewer', edgeType: 'sequential' }],
			};

			const result = formatAgentInput(roleWithContracts, upstreamOutputs, 'Review this', topology);

			expect(result).toContain('### From Implementer:');
			// Researcher has no edge to Reviewer, should be filtered out
			expect(result).not.toContain('### From Researcher:');
		});

		it('should include all upstream when topology has no edges to downstream', () => {
			const topology: WorkflowTopology = {
				pattern: 'custom',
				entryPoint: 'Implementer',
				exitPoint: 'Reviewer',
				edges: [], // No edges at all
			};

			const result = formatAgentInput(roleWithContracts, upstreamOutputs, 'Review this', topology);

			// With empty edges, fallback includes all
			expect(result).toContain('### From Implementer:');
			expect(result).toContain('### From Researcher:');
		});

		it('should work with only inputContract defined', () => {
			const roleInputOnly: TeamTemplateRole = {
				...baseRole,
				inputContract: ['Code changes'],
			};

			const result = formatAgentInput(roleInputOnly, upstreamOutputs, 'Review');
			expect(result).toContain('## Task Context');
			expect(result).toContain('### Original Request');
			expect(result).not.toContain('## Your Assignment');
		});

		it('should work with only outputContract defined', () => {
			const roleOutputOnly: TeamTemplateRole = {
				...baseRole,
				outputContract: ['Review comments'],
			};

			const result = formatAgentInput(roleOutputOnly, upstreamOutputs, 'Review');
			expect(result).toContain('## Task Context');
			expect(result).toContain('## Your Assignment');
			expect(result).toContain('- [ ] Review comments');
		});
	});
});

describe('formatSynthesisContext', () => {
	it('should format responses without contracts', () => {
		const result = formatSynthesisContext([
			{ roleName: 'Implementer', output: 'Done implementing.' },
			{ roleName: 'Reviewer', output: 'Code looks good.' },
		]);

		expect(result).toContain('## Agent Responses');
		expect(result).toContain('### Implementer');
		expect(result).toContain('Done implementing.');
		expect(result).toContain('### Reviewer');
		expect(result).toContain('Code looks good.');
	});

	it('should include contract metadata when available', () => {
		const result = formatSynthesisContext([
			{
				roleName: 'Implementer',
				output: 'Done.',
				outputContract: ['Code changes', 'Summary'],
			},
			{
				roleName: 'Reviewer',
				output: 'LGTM.',
				outputContract: ['Review comments', 'Approval'],
			},
		]);

		expect(result).toContain('### Implementer (expected to produce: Code changes, Summary)');
		expect(result).toContain('### Reviewer (expected to produce: Review comments, Approval)');
	});

	it('should handle mixed responses with and without contracts', () => {
		const result = formatSynthesisContext([
			{ roleName: 'Agent A', output: 'Output A', outputContract: ['Deliverable'] },
			{ roleName: 'Agent B', output: 'Output B' },
		]);

		expect(result).toContain('### Agent A (expected to produce: Deliverable)');
		expect(result).toContain('### Agent B\n');
	});
});
