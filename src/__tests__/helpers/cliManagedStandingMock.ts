/**
 * Module mocks for a suite that drives the CLI spawner (`spawnAgent`) with `fs` mocked wholesale
 * (MCOMP-09-04C). The bare CLI reads its managed binding through `createManagedBinding`, held to
 * `createHostInstallationStanding`; under a wholesale `fs` mock the binding file reads as corrupt
 * (fail closed) and the standing would ask the real credential store. Use both:
 *
 *   vi.mock('../../../shared/maestro-lib/managed/binding', async (importOriginal) =>
 *     (await import('../../helpers/cliManagedStandingMock')).fileFreeBindingModule(await importOriginal()));
 *   vi.mock('../../../cli/services/host-managed', async () =>
 *     (await import('../../helpers/cliManagedStandingMock')).standaloneHostManagedModule());
 *
 * The real binding over real files is proven in `cli/services/cli-managed-binding.test.ts`.
 */

import type * as BindingModule from '../../shared/maestro-lib/managed/binding';

type Binding = typeof BindingModule;

/**
 * The binding module with `createManagedBinding` reading no file: it answers from the installation
 * standing alone, standalone or managed-and-unreadable (what the real binding answers with no file
 * and no attached authority).
 */
export function fileFreeBindingModule(actual: Binding): Binding {
	return {
		...actual,
		createManagedBinding: (deps) => {
			const state = (): ReturnType<BindingModule.ManagedBinding['state']> => {
				const standing = deps.standing?.read();
				return standing?.standing === 'managed'
					? { state: 'unreadable', file: '(no file)', reason: standing.detail }
					: { state: 'standalone', files: [] };
			};
			return {
				state,
				reload: state,
				authority: () => {
					throw new Error('fileFreeBindingModule: authority() is not modeled');
				},
				enroll: () => Promise.reject(new Error('fileFreeBindingModule: enroll() is not modeled')),
				unenroll: () =>
					Promise.reject(new Error('fileFreeBindingModule: unenroll() is not modeled')),
			};
		},
	};
}

/** `host-managed` with a custody that holds nothing: refused by name, and the standing standalone. */
export function standaloneHostManagedModule(
	read: () => BindingModule.InstallationStanding = () => ({
		standing: 'standalone',
		detail: 'test: no custody',
	}),
	created: unknown[] = []
) {
	return {
		resolveHostCustody: (input: { userDataDir: string }) => ({
			ok: false as const,
			reason: `refused for ${input.userDataDir}`,
		}),
		createHostInstallationStanding: (input: unknown): BindingModule.InstallationStandingSource => {
			created.push(input);
			return { read: () => read() };
		},
	};
}
