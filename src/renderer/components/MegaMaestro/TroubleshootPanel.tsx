/**
 * The Troubleshoot tab of the Mega-Maestro window (MSX-03-03): the one place
 * the technical details of Connect appear.
 *
 * It shows the connect status as labelled rows, raw, including the request
 * number and any value shaped like an ID (the default view filters those out;
 * this tab does not), the endpoint socket in use and whether it is the
 * platform's standard socket or an override, the server host and port form
 * with its lookup (moved here in MSX-01-04), the classic enrollment request
 * and phases (MegaMaestroEnrollment), and the last refusal with its code and
 * the catalog's explanation (`explain(code)`, MSX-03-04: title, explanation and
 * fix, the advanced hint folded away). A Maestro-local code the catalog does not
 * know keeps Maestro's own sentence rather than the catalog's generic entry.
 *
 * Copy diagnostics (MSX-03-04) puts the bundle main built and redacted
 * (`enterprise:connectDiagnostics`) on the clipboard; the renderer never
 * assembles or sees anything else of it.
 *
 * Every save goes through the existing settings path (`megaServerSave`), which
 * main validates again. The socket override clears to an empty value, which
 * main and `resolveEndpointSocket` read as "use the standard socket".
 */

import { useEffect, useState, type ReactNode } from 'react';
import type { MegaServerLookup, MegaServerSettings } from '../../../shared/megaServer';
import {
	EMPTY_MEGA_SERVER,
	megaServerOrigin,
	megaServerSettingsProblem,
	resolveEndpointSocket,
} from '../../../shared/megaServer';
import type { Theme } from '../../types';
import type { ConnectStatusView } from '../../../main/enterprise/connect';
import { MEGA_CONNECT_COPY } from '../../../shared/megaConnect/copy';
import { viewFor } from '../../../shared/megaConnect/view';
import { explain, hasTroubleshootingEntry } from '../../../shared/megaConnect/troubleshooting';
import type { ConnectRefusal } from '../../../main/enterprise/connect';
import type { MegaConnectInputReason } from '../../../shared/megaConnect/input';
import { safeClipboardWrite } from '../../utils/clipboard';
import { flashCopiedToClipboard } from '../../utils/flashCopiedToClipboard';
import { ipcErrorMessage } from '../../utils/ipcErrorMessage';
import { notifyToast } from '../../stores/notificationStore';
import { hostPlatform } from '../../utils/platformUtils';
import { EnrollmentPhases, describeEnrollmentOutcome } from '../Settings/MegaMaestroEnrollment';
import { connectRefusalSentence, readLastConnectRefusal } from './ConnectCard';

export const MEGA_MAESTRO_COPY = {
	title: 'Mega-Maestro',
	intro:
		'Connect this desktop to a Mega-Maestro server, then ask it to approve this desktop. Nothing here changes your Maestro settings.',
	server: 'Server',
	host: 'Host name or IP address',
	port: 'Port',
	socket: 'Local endpoint socket',
	socketHelp:
		'The socket of the Mega-Maestro endpoint running on this machine. Leave it empty to use the standard socket.',
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

export function PanelButton({
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

/** Labelled rows: a term and its value per row. */
function Rows({ rows, testId }: { rows: Array<[string, ReactNode]>; testId: string }) {
	return (
		<dl className="grid grid-cols-[max-content,1fr] gap-x-3 gap-y-1 text-xs" data-testid={testId}>
			{rows.map(([term, value]) => (
				<div key={term} className="contents">
					<dt className="opacity-70">{term}</dt>
					<dd className="font-mono break-all">{value}</dd>
				</div>
			))}
		</dl>
	);
}

/**
 * Every field of a connect status, raw. Unlike `viewFor()` nothing is dropped
 * for looking like an ID: this tab is where those values are shown.
 */
export function connectStatusRows(current: ConnectStatusView): Array<[string, string]> {
	const c = MEGA_CONNECT_COPY;
	const status = current.status;
	const rows: Array<[string, string]> = [
		[c.troubleshootRowState, `${viewFor(status).indicatorWord} (${status.kind})`],
	];
	const add = (label: string, value: unknown) => {
		if (value === undefined || value === null || value === '') return;
		rows.push([label, String(value)]);
	};
	if (status.kind === 'browserOpened') {
		add(c.troubleshootRowRequest, status.request);
		add(c.troubleshootRowNumber, status.matchNumber);
		add(c.troubleshootRowServerName, status.serverName);
	} else if (status.kind === 'waiting') {
		add(c.troubleshootRowRequest, status.request);
	} else if (status.kind === 'connected') {
		add(c.troubleshootRowOrg, status.orgName);
		add(c.troubleshootRowTeam, status.teamPath);
		if (status.policy) {
			add(
				c.troubleshootRowPolicy,
				status.policy.revision === undefined
					? status.policy.name
					: `${status.policy.name}@${status.policy.revision}`
			);
		}
		if (typeof status.syncedAt === 'number' && Number.isFinite(status.syncedAt)) {
			add(c.troubleshootRowSynced, new Date(status.syncedAt).toISOString());
		}
	}
	add(c.troubleshootRowDevice, current.names?.device);
	add(c.troubleshootRowAccount, current.names?.account);
	add(c.troubleshootRowEndpointServer, current.names?.server);
	return rows;
}

/** The refusal line: the catalog's words when it knows the code, Maestro's own sentence otherwise. */
export function RefusalExplanation({
	refusal,
	reason,
}: {
	refusal: ConnectRefusal;
	reason?: MegaConnectInputReason;
}) {
	const c = MEGA_CONNECT_COPY;
	const explained = explain(refusal);
	return (
		<div className="space-y-1" data-testid="mega-ts-refusal-explained">
			{hasTroubleshootingEntry(refusal) ? (
				<>
					<p className="font-medium">{explained.title}</p>
					<p>{explained.explanation}</p>
					<p>
						<span className="font-medium">{c.troubleshootRefusalFix}: </span>
						{explained.fix}
					</p>
				</>
			) : (
				<p>{connectRefusalSentence(refusal, reason)}</p>
			)}
			<details>
				<summary className="cursor-pointer opacity-70">{c.troubleshootRefusalAdvanced}</summary>
				<p className="font-mono break-all" data-testid="mega-ts-refusal-advanced">
					{explained.advancedHint}
				</p>
			</details>
		</div>
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

export function TroubleshootPanel({ theme }: { theme: Theme }) {
	const api = typeof window !== 'undefined' ? window.maestro?.enterprise : undefined;
	const supported = typeof api?.megaServerGet === 'function';
	const connectApi = api?.connect;

	const [server, setServer] = useState<MegaServerSettings>(EMPTY_MEGA_SERVER);
	const [saved, setSaved] = useState<MegaServerSettings>(EMPTY_MEGA_SERVER);
	const [port, setPort] = useState(String(EMPTY_MEGA_SERVER.port));
	const [status, setStatus] = useState<string | null>(null);
	const [busy, setBusy] = useState<'save' | 'lookup' | 'request' | null>(null);
	const [lookup, setLookup] = useState<MegaServerLookup | null>(null);
	const [orgId, setOrgId] = useState('');
	const [tenantId, setTenantId] = useState('');
	const [issuer, setIssuer] = useState('');
	const [ca, setCa] = useState('');
	const [requestNote, setRequestNote] = useState<string | null>(null);
	const [connect, setConnect] = useState<ConnectStatusView>({ status: { kind: 'unavailable' } });
	const [lastRefusal] = useState(readLastConnectRefusal);
	const [copying, setCopying] = useState(false);

	// Main built and redacted the text; it goes to the clipboard as is.
	const copyDiagnostics = async () => {
		if (!connectApi || copying) return;
		setCopying(true);
		try {
			const text = await connectApi.diagnostics();
			if (!(await safeClipboardWrite(text))) throw new Error('The clipboard is not available.');
			flashCopiedToClipboard(undefined, MEGA_CONNECT_COPY.troubleshootDiagnosticsCopied);
		} catch (error) {
			notifyToast({
				color: 'red',
				title: MEGA_CONNECT_COPY.troubleshootDiagnosticsFailed,
				message: ipcErrorMessage(error),
			});
		} finally {
			setCopying(false);
		}
	};

	useEffect(() => {
		if (!supported) return;
		let cancelled = false;
		void api!.megaServerGet().then((value) => {
			if (cancelled || !value) return;
			setServer(value);
			setSaved(value);
			setPort(String(value.port));
		});
		return () => {
			cancelled = true;
		};
	}, [supported, api]);

	useEffect(() => {
		if (!connectApi) return;
		let cancelled = false;
		const take = (next: ConnectStatusView) => {
			if (!cancelled) setConnect(next);
		};
		void connectApi.status().then(take, () => undefined);
		const off = connectApi.onStatus(take);
		return () => {
			cancelled = true;
			off();
		};
	}, [connectApi]);

	const current = (): MegaServerSettings => ({ ...server, port: Number(port) });

	const persist = async (next: MegaServerSettings) => {
		if (!supported || busy) return;
		const problem = megaServerSettingsProblem(next);
		if (problem) {
			setStatus(problem);
			return;
		}
		setBusy('save');
		try {
			const outcome = await api!.megaServerSave(next);
			setStatus(outcome.status === 'saved' ? MEGA_MAESTRO_COPY.saved : outcome.message);
			if (outcome.status === 'saved') {
				setServer(next);
				setSaved(next);
			}
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
		const value = await api!.megaServerGet();
		if (!value || megaServerSettingsProblem(value)) {
			setRequestNote(MEGA_MAESTRO_COPY.needServer);
			return;
		}
		setBusy('request');
		try {
			const outcome = await api!.requestEnrollment({
				phase: 'request',
				socketPath: value.endpointSocket,
				management: { origin: megaServerOrigin(value), tenantId, issuerSha256: issuer },
				orgId,
				serverCaPem: ca,
			});
			setRequestNote(describeEnrollmentOutcome(outcome));
		} finally {
			setBusy(null);
		}
	};

	// The socket in use follows the SAVED value; what is typed is not in use until saved.
	const socket = resolveEndpointSocket(saved.endpointSocket, hostPlatform());
	const c = MEGA_CONNECT_COPY;

	return (
		<>
			<section aria-labelledby="mega-ts-status-heading" className="space-y-2">
				<h3 id="mega-ts-status-heading" className="font-medium">
					{c.troubleshootStatusTitle}
				</h3>
				<Rows rows={connectStatusRows(connect)} testId="mega-ts-status" />
			</section>

			<section aria-labelledby="mega-ts-refusal-heading" className="space-y-2">
				<h3 id="mega-ts-refusal-heading" className="font-medium">
					{c.troubleshootRefusalTitle}
				</h3>
				{lastRefusal ? (
					<div className="space-y-1 text-xs" data-testid="mega-ts-refusal">
						<Rows
							rows={[[c.troubleshootRefusalCode, lastRefusal.refusal]]}
							testId="mega-ts-refusal-code"
						/>
						<RefusalExplanation refusal={lastRefusal.refusal} reason={lastRefusal.reason} />
					</div>
				) : (
					<p className="text-xs opacity-70" data-testid="mega-ts-refusal">
						{c.troubleshootRefusalNone}
					</p>
				)}
			</section>

			<section aria-labelledby="mega-ts-diagnostics-heading" className="space-y-2">
				<h3 id="mega-ts-diagnostics-heading" className="font-medium">
					{c.troubleshootDiagnosticsTitle}
				</h3>
				<p className="text-xs opacity-70">{c.troubleshootDiagnosticsBody}</p>
				<PanelButton
					label={copying ? MEGA_MAESTRO_COPY.working : c.troubleshootCopyDiagnostics}
					onClick={() => void copyDiagnostics()}
					disabled={!connectApi || copying}
					theme={theme}
				/>
			</section>

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
			</section>

			<section aria-labelledby="mega-socket-heading" className="space-y-3">
				<h3 id="mega-socket-heading" className="font-medium">
					{c.troubleshootSocketTitle}
				</h3>
				<Rows
					testId="mega-ts-socket"
					rows={
						socket.socketPath === null
							? [[c.troubleshootSocketInUse, socket.reason]]
							: [
									[c.troubleshootSocketInUse, socket.socketPath],
									[
										c.troubleshootSocketSource,
										socket.source === 'saved'
											? c.troubleshootSocketOverridden
											: c.troubleshootSocketStandard,
									],
								]
					}
				/>
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
					<PanelButton
						label={busy === 'save' ? MEGA_MAESTRO_COPY.working : MEGA_MAESTRO_COPY.save}
						onClick={() => void persist(current())}
						disabled={!supported || busy !== null}
						theme={theme}
					/>
					<PanelButton
						label={busy === 'lookup' ? MEGA_MAESTRO_COPY.working : MEGA_MAESTRO_COPY.lookup}
						onClick={() => void runLookup()}
						disabled={!supported || busy !== null}
						theme={theme}
					/>
					<PanelButton
						label={c.troubleshootSocketUseStandard}
						onClick={() => void persist({ ...current(), endpointSocket: '' })}
						disabled={!supported || busy !== null || saved.endpointSocket === ''}
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
				<PanelButton
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
		</>
	);
}
