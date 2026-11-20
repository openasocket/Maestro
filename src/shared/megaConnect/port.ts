/**
 * ConnectPort: Maestro's own boundary for Connect to your organization.
 *
 * This is NOT a Mega-Maestro contract. It is the shape the connect service in
 * `src/main/enterprise/connect.ts` talks to. Until the Mega adapter exists
 * (MSX-02-08, over the contracts 0.5.0 endpoint operations) no port is bound,
 * and the service answers `endpoint_connect_unavailable`, a real refusal.
 *
 * Every value a port receives has already passed the shape checks in
 * `input.ts`. Every value it returns for display is a name (REQ-1042,
 * mega.acme.com, platform/web), never an ID; the approval URL and the matching
 * number are handled by main and are never logged.
 */

import type { MegaJoinLink } from './input';
import type { MegaConnectStatus } from './view';

/** How a person starts a connect, after main validated it. */
export type ConnectStartInput =
	| { kind: 'email'; email: string }
	| { kind: 'joinLink'; joinLink: MegaJoinLink }
	| { kind: 'teamCode'; teamCode: string; server: string }
	| { kind: 'managed' };

export type ConnectStartKind = ConnectStartInput['kind'];

/** What the endpoint answers when a connect request is opened. */
export interface ConnectStartResult {
	/** The request reference (1042 or "REQ-1042"); not a secret, never an ID. */
	requestNumber?: string | number;
	/** The browser page the person approves on. Opened by main only, never logged. */
	approvalUrl: string;
	/** The matching number the person picks in the browser. Shown, never logged. */
	number?: string | number;
	/** The server host the request went to (mega.acme.com): the approval URL must be on it. */
	server: string;
	/** The organization's display name (Acme), when the endpoint knows it. */
	tenantDisplayName?: string;
}

/** Optional display names a status may carry; labels only, never authority. */
export interface ConnectDisplayNames {
	/** The device's name (alice-mbp). */
	device?: string;
	/** The OS account's name (alice-mbp/alice). */
	account?: string;
	/** The server's DNS name (mega.acme.com). */
	server?: string;
}

export interface ConnectStatusResult {
	status: MegaConnectStatus;
	names?: ConnectDisplayNames;
}

export interface ConnectPort {
	start(input: ConnectStartInput): Promise<ConnectStartResult>;
	status(): Promise<ConnectStatusResult>;
	/** Revokes the calling OS account's grant on this installation. */
	disconnect(): Promise<void>;
}
