/**
 * The Mega-Maestro window: its own modal, separate from Settings. It holds only
 * what is about Mega-Maestro: the server address this desktop talks to, a lookup
 * of that server and of the local endpoint, the approval request that registers
 * this desktop with the server, and the enrollment and standing that follow.
 */

import { useEffect, useState } from 'react';
import type { MegaServerLookup, MegaServerSettings } from '../../../shared/megaServer';
import {
	EMPTY_MEGA_SERVER,
	megaServerOrigin,
	megaServerSettingsProblem,
} from '../../../shared/megaServer';
import type { Theme } from '../../types';
import { MODAL_PRIORITIES } from '../../constants/modalPriorities';
import { Modal } from '../ui/Modal';
import { MegaMaestroSettings } from '../Settings/MegaMaestroSettings';
import { EnrollmentPhases, describeEnrollmentOutcome } from '../Settings/MegaMaestroEnrollment';

export const MEGA_MAESTRO_COPY = {
	title: 'Mega-Maestro',
	intro:
		'Connect this desktop to a Mega-Maestro server, then ask it to approve this desktop. Nothing here changes your Maestro settings.',
	server: 'Server',
	host: 'Host name or IP address',
	port: 'Port',
	socket: 'Local endpoint socket',
	socketHelp: 'The socket of the Mega-Maestro endpoint running on this machine.',
	save: 'Save',
	lookup: 'Look up',
	saved: 'Saved.',
	notSaved: 'Not saved.',
	lookupTitle: 'What the lookup found',
	notLookedUp: 'Save a server, then look it up.',
	working: 'Working...',
	serverVersion: 'Server version',
	noVersion: 'Not published by the server',
	endpoint: 'Local endpoint',
	endpointNegotiated: 'Negotiated',
	versions: 'Versions this desktop runs',
	maestro: 'Maestro',
	library: 'Maestro library',
	contracts: 'Mega-Maestro contracts',
	contractsAbsent: 'Not set in this build',
	approval: 'Request approval',
	approvalIntro:
		'Enter the organization and the tenant from the Mega-Maestro console, its issuer fingerprint and its certificate. The request uses the saved server.',
	orgId: 'Organization ID',
	tenantId: 'Tenant ID',
	issuer: 'Issuer SHA-256 fingerprint',
	ca: 'Server CA certificate (PEM)',
	sendRequest: 'Request approval',
	needServer: 'Save a valid server first.',
	unsupported: 'This window needs the desktop app. It cannot reach Mega-Maestro from a browser.',
	steps: 'Then complete the enrollment with the console’s challenge and activation.',
} as const;

const FIELD_STYLE = (theme: Theme) => ({
	borderColor: theme.colors.border,
	backgroundColor: theme.colors.bgActivity,
	color: theme.colors.textMain,
});

function Field({
	id,
	label,
	value,
	onChange,
	theme,
	type = 'text',
	mono = false,
}: {
	id: string;
	label: string;
	value: string;
	onChange: (value: string) => void;
	theme: Theme;
	type?: string;
	mono?: boolean;
}) {
	return (
		<div className="space-y-1">
			<label htmlFor={id} className="text-xs font-medium">
				{label}
			</label>
			<input
				id={id}
				type={type}
				value={value}
				spellCheck={false}
				onChange={(event) => onChange(event.target.value)}
				className={`w-full px-2 py-1 rounded border text-sm ${mono ? 'font-mono' : ''}`}
				style={FIELD_STYLE(theme)}
			/>
		</div>
	);
}

function Button({
	label,
	onClick,
	disabled,
	theme,
}: {
	label: string;
	onClick: () => void;
	disabled: boolean;
	theme: Theme;
}) {
	return (
		<button
			type="button"
			disabled={disabled}
			onClick={onClick}
			className="px-3 py-2 rounded border text-sm disabled:opacity-55"
			style={{ borderColor: theme.colors.border, backgroundColor: theme.colors.bgActivity }}
		>
			{label}
		</button>
	);
}

function LookupResult({ lookup, theme }: { lookup: MegaServerLookup; theme: Theme }) {
	return (
		<div className="space-y-2 text-sm" aria-live="polite">
			<p>{lookup.message}</p>
			<dl className="grid grid-cols-[max-content,1fr] gap-x-3 gap-y-1 text-xs">
				<dt className="opacity-70">Reachable</dt>
				<dd>{lookup.reachable ? 'Yes' : 'No'}</dd>
				{lookup.httpStatus !== null ? (
					<>
						<dt className="opacity-70">Health route</dt>
						<dd>
							HTTP {lookup.httpStatus}
							{lookup.health ? `, status ${lookup.health}` : ''}
						</dd>
					</>
				) : null}
				<dt className="opacity-70">{MEGA_MAESTRO_COPY.serverVersion}</dt>
				<dd>
					{lookup.serverVersion ?? MEGA_MAESTRO_COPY.noVersion}
					<span className="block opacity-70">{lookup.serverVersionNote}</span>
				</dd>
			</dl>
			<div className="text-xs">
				<span className="font-medium">{MEGA_MAESTRO_COPY.endpoint}: </span>
				{lookup.endpoint.status === 'negotiated' ? (
					<span>
						{MEGA_MAESTRO_COPY.endpointNegotiated}, protocol {lookup.endpoint.protocol},
						capabilities{' '}
						{lookup.endpoint.capabilities.length > 0
							? lookup.endpoint.capabilities.join(', ')
							: 'none'}
					</span>
				) : (
					<span style={{ color: theme.colors.warning }}>{lookup.endpoint.message}</span>
				)}
			</div>
			<div className="text-xs">
				<p className="font-medium">{MEGA_MAESTRO_COPY.versions}</p>
				<ul className="ml-4 list-disc">
					<li>
						{MEGA_MAESTRO_COPY.maestro} {lookup.versions.maestro}
					</li>
					<li>
						{MEGA_MAESTRO_COPY.library} {lookup.versions.library}
					</li>
					<li>
						{MEGA_MAESTRO_COPY.contracts}:{' '}
						{lookup.versions.contracts ?? MEGA_MAESTRO_COPY.contractsAbsent}
					</li>
				</ul>
			</div>
			<p className="text-xs opacity-60">Checked {new Date(lookup.checkedAt).toLocaleString()}</p>
		</div>
	);
}

export function MegaMaestroModal({ theme, onClose }: { theme: Theme; onClose: () => void }) {
	const api = typeof window !== 'undefined' ? window.maestro?.enterprise : undefined;
	const supported = typeof api?.megaServerGet === 'function';

	const [server, setServer] = useState<MegaServerSettings>(EMPTY_MEGA_SERVER);
	const [port, setPort] = useState(String(EMPTY_MEGA_SERVER.port));
	const [status, setStatus] = useState<string | null>(null);
	const [busy, setBusy] = useState<'save' | 'lookup' | 'request' | null>(null);
	const [lookup, setLookup] = useState<MegaServerLookup | null>(null);
	const [orgId, setOrgId] = useState('');
	const [tenantId, setTenantId] = useState('');
	const [issuer, setIssuer] = useState('');
	const [ca, setCa] = useState('');
	const [requestNote, setRequestNote] = useState<string | null>(null);

	useEffect(() => {
		if (!supported) return;
		let cancelled = false;
		void api!.megaServerGet().then((saved) => {
			if (cancelled || !saved) return;
			setServer(saved);
			setPort(String(saved.port));
		});
		return () => {
			cancelled = true;
		};
	}, [supported, api]);

	const current = (): MegaServerSettings => ({ ...server, port: Number(port) });

	const save = async () => {
		if (!supported || busy) return;
		const next = current();
		const problem = megaServerSettingsProblem(next);
		if (problem) {
			setStatus(problem);
			return;
		}
		setBusy('save');
		try {
			const outcome = await api!.megaServerSave(next);
			setStatus(outcome.status === 'saved' ? MEGA_MAESTRO_COPY.saved : outcome.message);
			if (outcome.status === 'saved') setServer(next);
		} finally {
			setBusy(null);
		}
	};

	const runLookup = async () => {
		if (!supported || busy) return;
		setBusy('lookup');
		try {
			const result = await api!.megaServerLookup(current());
			setLookup(result);
		} finally {
			setBusy(null);
		}
	};

	const requestApproval = async () => {
		if (!supported || busy) return;
		const saved = await api!.megaServerGet();
		if (!saved || megaServerSettingsProblem(saved)) {
			setRequestNote(MEGA_MAESTRO_COPY.needServer);
			return;
		}
		setBusy('request');
		try {
			const outcome = await api!.requestEnrollment({
				phase: 'request',
				socketPath: saved.endpointSocket,
				management: { origin: megaServerOrigin(saved), tenantId, issuerSha256: issuer },
				orgId,
				serverCaPem: ca,
			});
			setRequestNote(describeEnrollmentOutcome(outcome));
		} finally {
			setBusy(null);
		}
	};

	return (
		<Modal
			theme={theme}
			title={MEGA_MAESTRO_COPY.title}
			priority={MODAL_PRIORITIES.CONFIRM}
			onClose={onClose}
			resizeKey="mega-maestro"
			defaultSize={{ width: 760, height: 820 }}
			minSize={{ width: 520, height: 480 }}
			closeOnBackdropClick
			footer={<Button label="Close" onClick={onClose} disabled={false} theme={theme} />}
		>
			<div className="space-y-6 p-4 select-text">
				<p className="text-sm opacity-80">{MEGA_MAESTRO_COPY.intro}</p>
				{!supported ? <p className="text-sm">{MEGA_MAESTRO_COPY.unsupported}</p> : null}

				<section aria-labelledby="mega-server-heading" className="space-y-3">
					<h3 id="mega-server-heading" className="font-medium">
						{MEGA_MAESTRO_COPY.server}
					</h3>
					<div className="grid grid-cols-[1fr,120px] gap-3">
						<Field
							id="mega-host"
							label={MEGA_MAESTRO_COPY.host}
							value={server.host}
							onChange={(host) => setServer((s) => ({ ...s, host }))}
							theme={theme}
						/>
						<Field
							id="mega-port"
							label={MEGA_MAESTRO_COPY.port}
							value={port}
							onChange={setPort}
							theme={theme}
							type="number"
						/>
					</div>
					<Field
						id="mega-socket"
						label={MEGA_MAESTRO_COPY.socket}
						value={server.endpointSocket}
						onChange={(endpointSocket) => setServer((s) => ({ ...s, endpointSocket }))}
						theme={theme}
						mono
					/>
					<p className="text-xs opacity-70">{MEGA_MAESTRO_COPY.socketHelp}</p>
					<div className="flex gap-2">
						<Button
							label={busy === 'save' ? MEGA_MAESTRO_COPY.working : MEGA_MAESTRO_COPY.save}
							onClick={() => void save()}
							disabled={!supported || busy !== null}
							theme={theme}
						/>
						<Button
							label={busy === 'lookup' ? MEGA_MAESTRO_COPY.working : MEGA_MAESTRO_COPY.lookup}
							onClick={() => void runLookup()}
							disabled={!supported || busy !== null}
							theme={theme}
						/>
					</div>
					{status ? (
						<p role="status" className="text-xs">
							{status}
						</p>
					) : null}
				</section>

				<section aria-labelledby="mega-lookup-heading" className="space-y-2">
					<h3 id="mega-lookup-heading" className="font-medium">
						{MEGA_MAESTRO_COPY.lookupTitle}
					</h3>
					{lookup ? (
						<LookupResult lookup={lookup} theme={theme} />
					) : (
						<p className="text-xs opacity-70">{MEGA_MAESTRO_COPY.notLookedUp}</p>
					)}
				</section>

				<section aria-labelledby="mega-approval-heading" className="space-y-3">
					<h3 id="mega-approval-heading" className="font-medium">
						{MEGA_MAESTRO_COPY.approval}
					</h3>
					<p className="text-xs opacity-70">{MEGA_MAESTRO_COPY.approvalIntro}</p>
					<div className="grid grid-cols-2 gap-3">
						<Field
							id="mega-org"
							label={MEGA_MAESTRO_COPY.orgId}
							value={orgId}
							onChange={setOrgId}
							theme={theme}
						/>
						<Field
							id="mega-tenant"
							label={MEGA_MAESTRO_COPY.tenantId}
							value={tenantId}
							onChange={setTenantId}
							theme={theme}
						/>
					</div>
					<Field
						id="mega-issuer"
						label={MEGA_MAESTRO_COPY.issuer}
						value={issuer}
						onChange={setIssuer}
						theme={theme}
						mono
					/>
					<div className="space-y-1">
						<label htmlFor="mega-ca" className="text-xs font-medium">
							{MEGA_MAESTRO_COPY.ca}
						</label>
						<textarea
							id="mega-ca"
							value={ca}
							rows={5}
							spellCheck={false}
							onChange={(event) => setCa(event.target.value)}
							className="w-full px-2 py-1 rounded border font-mono text-xs"
							style={FIELD_STYLE(theme)}
						/>
					</div>
					<Button
						label={busy === 'request' ? MEGA_MAESTRO_COPY.working : MEGA_MAESTRO_COPY.sendRequest}
						onClick={() => void requestApproval()}
						disabled={!supported || busy !== null}
						theme={theme}
					/>
					{requestNote ? (
						<p role="status" className="text-xs">
							{requestNote}
						</p>
					) : null}
					<p className="text-xs opacity-70">{MEGA_MAESTRO_COPY.steps}</p>
					{supported ? <EnrollmentPhases theme={theme} onAnswered={() => undefined} /> : null}
				</section>

				{supported ? <MegaMaestroSettings theme={theme} /> : null}
			</div>
		</Modal>
	);
}
