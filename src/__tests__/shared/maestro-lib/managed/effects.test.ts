import { describe, expect, it, vi } from 'vitest';
import { createLocalHostAuthority } from '../../../../shared/maestro-lib/managed/authority';
import {
	createManagedEffectAuthority,
	effectDigest,
	effectGranted,
	EFFECT_REVOKED,
	type ManagedEffect,
	type ManagedEffectBinding,
	type ManagedEffectProducer,
	type ManagedEffectAuthorization,
	type ManagedEffectRequest,
} from '../../../../shared/maestro-lib/managed/effects';
import { NOW, runAdmission } from '../../../main/enterprise/fakeManaged';

// Declared local producer; no endpoint, provider or native confinement qualification.
async function fixture() {
	let clock = NOW;
	const authority = createLocalHostAuthority({
		authorityId: 'fixture',
		newId: () => 'fixture-lease',
		now: () => clock,
		decide: () => ({ decision: 'allow', policyRevision: 3 }),
	});
	const admitted = await authority.admit(runAdmission('run', 'launch'));
	if (admitted.state !== 'admitted') throw new Error(admitted.state);
	const { lease } = admitted;
	lease.bind(123);
	const ended = new AbortController();
	lease.onRevoked(() => ended.abort());
	const caller = new AbortController();
	const effect: ManagedEffect = {
		kind: 'tool-call',
		tool: 'Write',
		input: { content: 'one' },
		request: { method: 'Write', input: { file_path: '/fixture/a', content: 'one' } },
	};
	const binding: ManagedEffectBinding = {
		leaseId: lease.leaseId,
		actor: lease.actor,
		provider: 'claude-code',
		threadId: 'thread',
		turnId: 'turn',
		requestId: 'effect-1',
	};
	const allow = (request: ManagedEffectRequest): ManagedEffectAuthorization => ({
		decision: 'allow',
		receipt: {
			receiptId: `receipt-${request.binding.requestId}`,
			effectDigest: request.effectDigest,
			policyRevision: request.policyRevision,
			expiresAt: new Date(NOW + 1000).toISOString(),
		},
	});
	const producer: ManagedEffectProducer = {
		version: 1,
		authorityId: 'fixture',
		authorize: vi.fn(async (request) => allow(request)),
		consume: vi.fn(async (_request, receipt) => ({ decision: 'allow' as const, receipt })),
	};
	let selected: ManagedEffectProducer | null = producer;
	let live = true;
	const consumer = createManagedEffectAuthority({
		authorityId: () => 'fixture',
		producer: () => selected,
		now: () => clock,
		scope: () => ({
			lease,
			generation: 'registered-policy-3',
			signal: ended.signal,
			current: () => live && lease.state() === 'bound',
		}),
	});
	return {
		authority,
		lease,
		ended,
		caller,
		effect,
		binding,
		producer,
		consumer,
		allow,
		decide: () => consumer.decide(effect, binding, caller.signal),
		setProducer: (value: ManagedEffectProducer | null) => {
			selected = value;
		},
		advance: () => {
			clock += 1001;
		},
		invalidate: () => {
			live = false;
		},
	};
}

describe('EFFECT/1 local receipt consumer', () => {
	it('sends exact input and consumes the correlated receipt once before granting', async () => {
		const f = await fixture();
		const decision = await f.decide();
		expect(effectGranted(decision)).toBe(true);
		const request = vi.mocked(f.producer.authorize).mock.calls[0][0];
		expect(request).toEqual({
			version: 1,
			effect: f.effect,
			binding: f.binding,
			effectDigest: effectDigest(f.effect, f.binding),
			policyRevision: 3,
			generation: 'registered-policy-3',
		});
		expect(request.effect).not.toBe(f.effect);
		expect(f.producer.consume).toHaveBeenCalledOnce();
		expect(await f.decide()).toMatchObject({ decision: 'deny' });
		expect(f.producer.authorize).toHaveBeenCalledOnce();
		f.advance();
		expect(effectGranted(decision)).toBe(false);
	});

	it.each(['absent', 'version', 'authority'] as const)('holds a %s producer', async (kind) => {
		const f = await fixture();
		f.setProducer(
			kind === 'absent'
				? null
				: {
						...f.producer,
						...(kind === 'version' ? { version: 2 as 1 } : { authorityId: 'other' }),
					}
		);
		expect(await f.decide()).toMatchObject({ decision: 'unavailable' });
		expect(f.producer.authorize).not.toHaveBeenCalled();
	});

	it('refuses a lossy request without calling the producer', async () => {
		const f = await fixture();
		delete f.effect.request;
		expect(await f.decide()).toMatchObject({ decision: 'unavailable' });
		expect(f.producer.authorize).not.toHaveBeenCalled();
	});

	it.each(['deny', 'unavailable', 'unknown'] as const)(
		'preserves %s without consumption or retry',
		async (decision) => {
			const f = await fixture();
			vi.mocked(f.producer.authorize).mockResolvedValue({ decision, reason: 'fixture' });
			expect(await f.decide()).toEqual({ decision, reason: 'fixture' });
			expect(await f.decide()).toEqual({ decision, reason: 'fixture' });
			expect(f.producer.authorize).toHaveBeenCalledOnce();
			expect(f.producer.consume).not.toHaveBeenCalled();
		}
	);

	it.each(['digest', 'policy', 'expired', 'missing'] as const)(
		'holds a %s receipt before consume',
		async (kind) => {
			const f = await fixture();
			vi.mocked(f.producer.authorize).mockImplementation(async (request) => {
				const answer = f.allow(request);
				if (answer.decision !== 'allow') throw new Error('fixture');
				if (kind === 'digest') answer.receipt.effectDigest = 'wrong';
				if (kind === 'policy') answer.receipt.policyRevision++;
				if (kind === 'expired') answer.receipt.expiresAt = new Date(NOW).toISOString();
				if (kind === 'missing') answer.receipt.receiptId = '';
				return answer;
			});
			expect(await f.decide()).toMatchObject({ decision: 'unknown' });
			expect(f.producer.consume).not.toHaveBeenCalled();
		}
	);

	it.each(['authorize', 'consume'] as const)(
		'holds lost %s responses even after disconnect',
		async (method) => {
			const f = await fixture();
			vi.mocked(f.producer[method]).mockRejectedValue(new Error('lost response'));
			expect(await f.decide()).toMatchObject({ decision: 'unknown' });
			f.setProducer(null);
			expect(await f.decide()).toMatchObject({ decision: 'unknown' });
			expect(f.producer[method]).toHaveBeenCalledOnce();
		}
	);

	it.each(['caller', 'lease', 'release'] as const)(
		'interrupts a pending receipt on %s end',
		async (kind) => {
			const f = await fixture();
			vi.mocked(f.producer.authorize).mockImplementation(() => new Promise(() => {}));
			const pending = f.decide();
			if (kind === 'caller') f.caller.abort();
			else if (kind === 'lease') f.authority.revoke(f.lease.leaseId, 'fixture revoke');
			else f.ended.abort();
			expect(await pending).toEqual(EFFECT_REVOKED);
			expect(await f.decide()).toMatchObject({ decision: 'unknown' });
			expect(f.producer.consume).not.toHaveBeenCalled();
		}
	);

	it.each(['effect', 'binding', 'standing', 'producer'] as const)(
		'holds changes to %s during authorize',
		async (kind) => {
			const f = await fixture();
			vi.mocked(f.producer.authorize).mockImplementation(async (request) => {
				if (kind === 'effect') f.effect.request!.input = { content: 'changed' };
				if (kind === 'binding') f.binding.requestId = 'changed';
				if (kind === 'standing') f.invalidate();
				if (kind === 'producer') f.setProducer({ ...f.producer });
				return f.allow(request);
			});
			expect(effectGranted(await f.decide())).toBe(false);
			expect(f.producer.consume).not.toHaveBeenCalled();
		}
	);

	it('holds concurrent replay and refuses a mutated consumption receipt', async () => {
		const f = await fixture();
		let settle!: (value: ManagedEffectAuthorization) => void;
		vi.mocked(f.producer.authorize).mockImplementation(
			() =>
				new Promise((resolve) => {
					settle = resolve;
				})
		);
		const pending = f.decide();
		expect(await f.decide()).toMatchObject({ decision: 'unknown' });
		const request = vi.mocked(f.producer.authorize).mock.calls[0][0];
		vi.mocked(f.producer.consume).mockImplementation(async (_request, receipt) => ({
			decision: 'allow',
			receipt: { ...receipt, receiptId: 'different' },
		}));
		settle(f.allow(request));
		expect(await pending).toMatchObject({ decision: 'unknown' });
	});

	it('does not let a consumed receipt authorize another request', async () => {
		const f = await fixture();
		vi.mocked(f.producer.authorize).mockImplementation(async (request) => {
			const answer = f.allow(request);
			if (answer.decision === 'allow') answer.receipt.receiptId = 'reused';
			return answer;
		});
		expect(effectGranted(await f.decide())).toBe(true);
		f.binding.requestId = 'effect-2';
		expect(await f.decide()).toMatchObject({ decision: 'unknown' });
		expect(f.producer.consume).toHaveBeenCalledOnce();
	});

	it.each(['caller', 'lease', 'input', 'standing'] as const)(
		'rechecks %s at the reply sink',
		async (kind) => {
			const f = await fixture();
			const decision = await f.decide();
			if (kind === 'caller') f.caller.abort();
			if (kind === 'lease') f.authority.revoke(f.lease.leaseId, 'fixture');
			if (kind === 'input') f.effect.request!.input = { content: 'changed' };
			if (kind === 'standing') f.invalidate();
			expect(effectGranted(decision)).toBe(false);
		}
	);
	it.each(['cancel', 'mutation', 'policy'] as const)(
		'holds %s during receipt consumption',
		async (change) => {
			const f = await fixture();
			vi.mocked(f.producer.consume).mockImplementation(async (_request, receipt) => {
				if (change === 'cancel') f.caller.abort();
				if (change === 'mutation') f.effect.request!.input = { content: 'changed' };
				if (change === 'policy') f.invalidate();
				return { decision: 'allow', receipt };
			});
			expect(effectGranted(await f.decide())).toBe(false);
			expect(await f.decide()).toMatchObject({ decision: 'unknown' });
		}
	);

	it('does not let a producer extend a consumed receipt after returning it', async () => {
		const f = await fixture();
		const decision = await f.decide();
		const receipt = vi.mocked(f.producer.consume).mock.calls[0][1];
		receipt.expiresAt = new Date(NOW + 100000).toISOString();
		expect(effectGranted(decision)).toBe(false);
	});

	it('binds file contents and network fields into the exact effect digest', async () => {
		const f = await fixture();
		const original = effectDigest(f.effect, f.binding);
		f.effect.request!.input = { file_path: '/fixture/a', content: 'two', network: { body: 'two' } };
		expect(effectDigest(f.effect, f.binding)).not.toBe(original);
	});
});
