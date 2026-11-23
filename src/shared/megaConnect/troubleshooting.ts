/**
 * The error catalog, transcribed from the contracts 0.5.1 troubleshooting
 * module (SIMPLE-06-01): one plain explanation and fix for every refusal and
 * outcome code a person can meet. The console, the endpoint (`doctor`) and
 * Maestro render from it, so everyone reads the same words.
 *
 * It is transcribed, not imported, because no product code loads the vendored
 * contracts (the house style of `input.ts` and `endpoint-port.ts`). The
 * tables below are the vendored tables verbatim; a test holds every code's
 * `explain()` deep-equal to the vendored one, the key sets equal, and the
 * generic entry for an unknown code equal. On a contracts re-pin, copy the
 * tables again and let that test say what moved.
 *
 * These are the endpoint's codes. Maestro's own connect refusals
 * (`ConnectRefusal` in `src/main/enterprise/connect.ts`) are mostly not in it;
 * `hasTroubleshootingEntry()` tells a caller when `explain()` would only answer
 * the generic entry.
 */

export type TroubleshootingAudience = 'user' | 'admin';
export type TroubleshootingSeverity = 'info' | 'warning' | 'error';

export interface Explanation {
	title: string;
	explanation: string;
	likelyCause: string;
	fix: string;
	audience: TroubleshootingAudience;
	severity: TroubleshootingSeverity;
	/** Technical detail for the Advanced view: what the check refused. */
	advancedHint: string;
	/** The one button Maestro or the console offers, when there is one. */
	action?: string;
}

const doctor = 'run mega-maestro-endpoint doctor';
// Shared text: group | audience | severity | explanation | likely cause | fix.
const groupTable = `
setup | admin | error | The Mega-Maestro endpoint on this computer found its own files or installation in a state it does not trust, so it stopped instead of guessing. | Files in the endpoint's state directory were edited, copied from another computer or given the wrong owner or permissions, or the installation is incomplete. | As an administrator, ${doctor}, then repair or reinstall the endpoint. Never edit its state files by hand.
busy | user | warning | The Mega-Maestro endpoint is busy, starting or stopping, so it did not take this request. | Many requests arrived at once, the endpoint service is restarting, or another policy or inbox update is still running. | Wait a few seconds and try again. If it keeps happening, restart the endpoint service.
notConnected | user | warning | This computer is not connected to your organization yet, so the endpoint has nothing to act under. | The device was never connected, its connection was removed, or connecting did not finish. | Connect from Maestro. If you already did, ask your admin to check Requests.
changed | user | warning | This device's connection changed while the request was running, so the endpoint stopped rather than finish under the old connection. | The device was reconnected, re-approved or revoked, or the endpoint was reinstalled, during the request. | Try again. If it keeps happening, connect again from Maestro.
app | user | error | The endpoint could not confirm which app on this computer is asking, so it refused. | The asking program is not a Maestro this device approved, or it disconnected in the middle of the request. | Restart Maestro and try again. If it keeps happening, ask your admin to ${doctor}.
registration | user | warning | This Maestro's registration with the endpoint is missing, expired or no longer matches this Maestro. | Maestro restarted or waited too long, its registration expired, or the same registration was used twice. | Restart Maestro so it registers again. If it keeps happening, connect again from Maestro.
policyUntrusted | admin | error | The device refused a policy update because it could not prove the update came unchanged from your organization. It keeps enforcing its last trusted policy. | The delivery was altered, is older than one already installed, two different versions claimed the same revision, or the signing key is not one this device trusts. | Check the policy's signing keys and rollout in the console, then publish a new revision.
policyPending | user | warning | The device's policy is not in effect yet or could not be confirmed, so actions that need it wait. | The policy starts later, the device clock cannot be trusted, or a newer policy arrived while this one was being confirmed. | Keep the device online and check that its clock is correct, then try again. Ask your admin if it does not clear within a few minutes.
policyServer | admin | error | The server could not prepare, sign or deliver this policy. | A signing key, assignment or evidence record is missing or too large, or the policy uses a feature this deployment cannot verify yet. | Check the policy, its assignment and the signing keys in the console, then publish again. If it persists, search the API logs for this code.
policyAuthoring | admin | error | The policy cannot be compiled, so it was not saved or delivered. | Two rules contradict each other, an ID repeats, or the policy is larger than the limits allow. | Edit the policy so the named rules no longer conflict, then save again.
notice | user | info | A notice from your organization is no longer available on this device. | The notice expired, your admin withdrew it, or the inbox on this device is full. | Nothing to do. Ask your admin if you still need the notice.
noticeState | admin | error | The device's notice inbox failed an integrity check, so the endpoint stopped using it rather than show something wrong. | The inbox's stored records were changed or are out of step with the server, or an earlier write did not finish. | Restart the endpoint service so it recovers the inbox. If it persists, ${doctor} and send the bundle to your admin.
blocked | user | warning | Your organization's policy does not allow this on this device. | A rule in the policy assigned to this device blocks this action or this data. | If you need it, ask your admin to change the policy or grant an exception.
component | admin | error | A part of the endpoint this action needs is not set up or not running on this device. | The feature is not configured in this device's policy or installation, or its state could not be read. | Check this device's policy and endpoint installation; ${doctor} to see which part is missing.
runtime | admin | error | The Maestro runtime on this device could not be started or checked, so no work runs on it. | The installed runtime does not match the version your organization pins, or its state could not be opened. | Install the runtime version your organization pins, then restart the endpoint service.
request | user | warning | The server did not accept this request. | The request was out of date, malformed or not allowed for your account. | Reload the page and try again.
`;
// One row per code: code | group | title | advanced hint. The group supplies the explanation,
// likely cause, fix, audience and severity. Rows are text so the formatter keeps them one per line.
const grouped = `
ENDPOINT_DLP_COLLECTION_DENIED | blocked | Data collection blocked | The event carries content references or the policy allows no metadata collection.
ENDPOINT_DLP_DENIED | blocked | Blocked by a data rule | Data loss prevention inspection denied or changed the payload.
ENDPOINT_DLP_FINGERPRINT_KEY_UNAVAILABLE | component | Data fingerprint key missing | A fingerprint DLP rule needs tenant-scoped key custody, which is not installed.
ENDPOINT_DLP_UNAVAILABLE | component | Data rules unavailable | DLP custody is missing, belongs to another tenant, or the payload limit is zero.
ENDPOINT_FINANCE_STATE_UNAVAILABLE | component | Budget state unavailable | The finance state file could not be read or validated.
ENDPOINT_GATEWAY_RUNTIME_UNAVAILABLE | component | Model gateway not running | The gateway provider runtime is not available.
ENDPOINT_GATEWAY_STATE_UNAVAILABLE | component | Model gateway state unavailable | The gateway session record could not be read or validated.
ENDPOINT_GATEWAY_UNAVAILABLE | component | Model gateway unavailable | The gateway provider refused or returned an invalid answer.
ENDPOINT_LOCAL_MODEL_UNAVAILABLE | component | Local model unavailable | The local model provider refused or returned an invalid answer.
ENDPOINT_LOCAL_RUNTIME_UNAVAILABLE | component | Local model not running | The local model runtime is not available.
ENDPOINT_LOCAL_STATE_UNAVAILABLE | component | Local model state unavailable | The local session record could not be read or validated.
ENDPOINT_OFFLINE_BUDGET_UNAVAILABLE | component | Offline budget unavailable | The offline budget state could not be read.
ENDPOINT_OFFLINE_DENIED | blocked | Not allowed while offline | The offline allowance refused the request; its reason is in the detail.
ENDPOINT_QUEUE_LIMIT | busy | Endpoint is busy | 128 operations were already in flight.
ENDPOINT_SECURITY_BINDING | changed | Security session changed | The security session expired or no longer matches the compiled policy.
ENDPOINT_SECURITY_BUSY | busy | Security checks are busy | Another inspection is pending or the spool is closing.
ENDPOINT_SECURITY_INCOMPLETE | component | Security checks incomplete | The invocation reached a step out of order or without accounting.
ENDPOINT_SECURITY_POLICY_MISMATCH | policyPending | Security policy does not match | The spool's installed rules differ from the compiled policy.
ENDPOINT_SECURITY_READ_ONLY | setup | Security journal is read-only | A failed write blocked the security spool.
ENDPOINT_SECURITY_RESERVED | request | Reserved security event | Security decisions and accounting evidence come only from the endpoint itself.
ENDPOINT_SECURITY_UNAVAILABLE | component | Security checks unavailable | The security spool is not open or was released.
ENDPOINT_STOPPING | busy | Endpoint is stopping | The endpoint service is shutting down.
ENROLLMENT_MANAGEMENT | changed | Managed server changed | The enrollment's origin, tenant or issuer pin differs from the managed configuration.
ENROLLMENT_PHASE | notConnected | Connecting has not finished | No management binding exists for this step yet.
IPC_BINDING_CHANGED | changed | Device connection changed | The binding digest changed between preparing and finishing.
IPC_BINDING_DIRECTORY | setup | Endpoint directory is unsafe | A state directory is not absolute, owner-only and free of symlinks.
IPC_BINDING_FILE | setup | Endpoint file is unsafe | A binding file is not a single-link, owner-only file under 16 KiB.
IPC_BINDING_MISMATCH | app | App identity does not match | The stored registration names a different peer identity.
IPC_BINDING_SIZE | setup | Endpoint file is too large | A binding file exceeds 16 KiB.
IPC_ENROLLED | request | Already connected | The device already holds a certificate, so a new enrollment is refused.
IPC_INBOX_AVAILABILITY_MISMATCH | changed | Inbox belongs to another installation | The inbox availability answer names another installation.
IPC_INBOX_BINDING_MISMATCH | app | Inbox app identity does not match | The peer context differs from the inbox binding.
IPC_INBOX_IDENTITY_CHANGED | changed | Device connection changed | The enrollment digest changed under the inbox.
IPC_INBOX_RECEIPT_MISMATCH | noticeState | Notice receipt does not match | The server's receipt state differs from the requested action.
IPC_INBOX_RECEIPT_UNRESOLVED | noticeState | Notice receipt unresolved | The receipt for an earlier notice action could not be resolved.
IPC_INBOX_RECOVERY_ADMISSION_UNAVAILABLE | noticeState | Inbox recovery unavailable | The journal cannot admit a recovered entry.
IPC_INBOX_RECOVERY_REQUIRED | noticeState | Inbox needs recovery | A persisted ambiguous action must be reconciled before new ones.
IPC_INBOX_REGISTRATION_REQUIRED | registration | Inbox registration missing | No inbox registration exists for this runtime and process.
IPC_INSTALLATION_CHANGED | setup | Installation changed | Re-verifying the installation evidence failed.
IPC_NATIVE_ABI | setup | Native module does not match | The peer native module has an unexpected ABI.
IPC_NATIVE_UNAVAILABLE | setup | Native module missing | The peer native module could not be loaded; nothing falls back.
IPC_PEER_ACCOUNT | setup | Wrong service account | The connecting process is not the endpoint's service account.
IPC_PEER_CHANGED | app | App changed during the request | The peer's identity digest changed mid-request.
IPC_PEER_DISCONNECTED | app | App disconnected | The socket closed or its handle changed during inspection.
IPC_PEER_INVALID | app | App identity unreadable | The OS peer identity did not parse.
IPC_PEER_UNAVAILABLE | app | App identity unavailable | No peer authority, or the socket is closed.
IPC_PIPE_CONFIG | setup | Pipe settings invalid | The named-pipe timeout is outside 10 ms to 30 s.
IPC_PLATFORM_UNSUPPORTED | setup | Platform not supported | This protected path runs on Linux only.
IPC_PROTECTED_INSTALLATION_UNAVAILABLE | setup | Protected installation missing | Development binding was requested outside development mode.
IPC_REGISTRATION_CHALLENGE | registration | Registration challenge does not match | The server's challenge does not answer this scope.
IPC_REGISTRATION_CHANGED | registration | Registration changed | The stored registration differs from the one being used.
IPC_REGISTRATION_EXISTS | registration | Already registered | A registration for this runtime is already stored.
IPC_REGISTRATION_EXPIRED | registration | Registration expired | The registration challenge expired.
IPC_REGISTRATION_LIVE_UNAVAILABLE | registration | Registration check unavailable | No live registration reader is open.
IPC_REGISTRATION_MISMATCH | registration | Registration does not match | The server's registration differs in scope or expiry.
IPC_REGISTRATION_REPLAY | registration | Registration already used | The registration challenge was already consumed.
IPC_REGISTRATION_STORAGE_LIMIT | setup | Too many registrations stored | The registration directory holds over 509 entries or an unknown file.
IPC_REGISTRATION_UNAVAILABLE | busy | Registration not open yet | The registration provisioner is not open.
IPC_RUNTIME_USE_REGISTRATION_REQUIRED | registration | Registration missing | The request carries no valid runtime-use registration.
IPC_SERVICE_ACCOUNT | setup | Wrong service account | The endpoint is not running as its installed service account.
IPC_SOCKET_INVALID | app | Connection is not local | The socket is closed, remote or has no file descriptor.
IPC_TIMEOUT_CONFIG | setup | Timeout setting invalid | The IPC timeout is outside 10 ms to 30 s.
IPC_UNENROLLED | notConnected | Not connected | No enrollment is stored on this device.
NOTICE_ACTION_CONFLICT | noticeState | Notice action conflicts | A different action was already recorded for this notice.
NOTICE_ALREADY_OPEN | busy | Inbox already open | The notice inbox was opened twice.
NOTICE_CAPACITY | notice | Inbox is full | The inbox state would exceed its byte limit.
NOTICE_COPY_CUSTODY_UNAVAILABLE | noticeState | Notice copy unavailable | A stored notice copy no longer matches its release.
NOTICE_COPY_WITHDRAWN | notice | Notice withdrawn | Your admin withdrew this notice.
NOTICE_CUSTODY_CHANGED | noticeState | Inbox storage changed | The encrypted inbox state changed outside the endpoint.
NOTICE_CUSTODY_MISMATCH | noticeState | Inbox storage does not match | The inbox marker names another enrollment or key.
NOTICE_CUSTODY_UNAVAILABLE | component | Inbox storage unavailable | No inbox custody is installed on this device.
NOTICE_DELIVERY_BINDING_REJECTED | noticeState | Notice delivery rejected | The delivery claim no longer matches the message or recipient.
NOTICE_DELIVERY_FENCE_REJECTED | noticeState | Notice delivery superseded | A newer delivery claim fenced this one.
NOTICE_DELIVERY_MISMATCH | noticeState | Notice does not match | The release payload digest does not match the notice.
NOTICE_DELIVERY_PARTIAL | busy | Some notices were not delivered | At least one delivery in the batch failed; the rest retry.
NOTICE_DELIVERY_RECEIPT_MISMATCH | noticeState | Notice receipt does not match | The receipt names another release.
NOTICE_DELIVERY_UNAVAILABLE | busy | Notice delivery busy | Delivery is closed or another delivery is running.
NOTICE_ENROLLMENT_CHANGED | changed | Device connection changed | The enrollment changed under notice delivery.
NOTICE_ENROLLMENT_REQUIRED | notConnected | Not connected | Notices need an enrollment on this device.
NOTICE_EVIDENCE_BINDING | noticeState | Notice evidence does not match | Recovery evidence is missing or not marked recovered.
NOTICE_EVIDENCE_CONFLICT | noticeState | Notice evidence conflicts | Different evidence was already stored under this ID.
NOTICE_EVIDENCE_MISSING | noticeState | Notice evidence missing | No evidence with this ID is stored.
NOTICE_EVIDENCE_SIZE | noticeState | Notice evidence too large | The evidence exceeds 4 KiB.
NOTICE_EXPIRED | notice | Notice expired | The notice's expiry or retention window has passed.
NOTICE_INBOX_UNAVAILABLE | busy | Inbox busy | The inbox is closed, busy, or stopped after a failed write.
NOTICE_KEY_REQUIRED | noticeState | Inbox key missing | The inbox content key is missing or malformed.
NOTICE_POLICY_UNAVAILABLE | policyPending | Notice policy not installed | No installed tenant policy matches the notice source.
NOTICE_RECOVERY_REQUIRED | noticeState | Inbox needs recovery | Leftover state from an earlier run must be recovered first.
NOTICE_REGISTRATION_CHANGED | registration | Registration changed | The runtime registration changed during notice delivery.
NOTICE_REGISTRATION_DENIED | registration | Registration not valid for notices | The registration names another enrollment or has expired.
NOTICE_RELEASE_CONFLICT | noticeState | Notice release conflicts | A different release was already stored under this ID.
NOTICE_RELEASE_MISSING | notice | Notice not found | No release with this ID is stored.
NOTICE_SESSION_LIMIT | busy | Too many inbox sessions | 64 runtimes already hold inbox sessions.
NOTICE_STATE_BINDING | noticeState | Inbox state does not match | A stored entry or ticket fails its binding checks.
NOTICE_STATE_INVALID | noticeState | Inbox state invalid | A stored record is not a security-lane payload.
NOTICE_STATE_REQUIRED | noticeState | Inbox state missing | The inbox journal holds no or too many state records.
NOTICE_TICKET_MISSING | noticeState | Notice ticket missing | No ticket with this ID is stored.
NOTICE_WITHDRAWAL_BINDING | noticeState | Withdrawal does not match | The withdrawal names another installation.
NOTICE_WITHDRAWAL_EXPIRED | busy | Withdrawal timed out | The withdrawal round trip exceeded its window.
NOTICE_WITHDRAWAL_MISMATCH | noticeState | Withdrawal out of order | The withdrawal cursor or expiry is out of bounds.
NOTICE_WITHDRAWAL_READBACK | noticeState | Withdrawal not saved | Reading the withdrawal back from disk failed.
NOTICE_WITHDRAWAL_RECEIPT_MISMATCH | noticeState | Withdrawal receipt does not match | The receipt names another copy.
NOTICE_WITHDRAWAL_UNAVAILABLE | component | Withdrawal unavailable | The client cannot withdraw notice copies.
POLICY_ASSIGNMENT_EQUIVOCATION | policyUntrusted | Two different policy assignments | The same assignment revision arrived with different content.
POLICY_ASSIGNMENT_RECEIPT_MISMATCH | policyUntrusted | Policy receipt does not match | The server's assignment receipt differs from the one sent.
POLICY_ASSIGNMENT_ROLLBACK | policyUntrusted | Older policy assignment refused | The assignment revision is lower than the installed one.
POLICY_ASSIGNMENT_SIZE | policyServer | Policy assignment too large | The compiled assignment exceeds 8 MiB.
POLICY_ASSIGNMENT_UNTRUSTED | policyUntrusted | Policy assignment not trusted | The assignment failed tenant or signature verification.
POLICY_BINDING_CHANGED | changed | Device connection changed | The authenticated binding changed during policy delivery.
POLICY_BOOTSTRAP_UNAVAILABLE | policyPending | Policy not set up yet | The policy cache has not been provisioned.
POLICY_BUSY | busy | Policy update running | Another policy provision, install or recovery is running.
POLICY_CACHE_ADMISSION_LIMIT | busy | Policy cache busy | 64 policy cache operations are already waiting.
POLICY_CACHE_DIGEST | setup | Policy cache damaged | A cached policy file does not match its digest.
POLICY_CACHE_DIRECTORY | setup | Policy cache directory unsafe | The cache directory is not owner-only or is a symlink.
POLICY_CACHE_FILE | setup | Policy cache file unsafe | A cache file is not a single-link owner-only file within its size limit.
POLICY_CACHE_LOCK_CHANGED | setup | Policy cache lock replaced | The cache lock file changed while held.
POLICY_CACHE_MISSING | setup | Policy cache file missing | An expected cache file is missing.
POLICY_CACHE_NON_REENTRANT | busy | Policy cache already in use | A nested writer tried to enter the cache.
POLICY_CACHE_RECOVERY | setup | Policy recovery record damaged | The recovery record does not match its digest.
POLICY_CACHE_RELEASE_FAILED | setup | Policy cache stopped | An earlier cache release failed, so the cache refuses new work.
POLICY_CACHE_RETENTION_LIMIT | setup | Policy cache too full | The cache directory holds 512 or more entries.
POLICY_CACHE_SIZE | setup | Policy cache file too large | A cache file exceeds its size limit.
POLICY_CACHE_TENANT | policyUntrusted | Cached policy belongs to another organization | The cached bundle's tenant differs from the cache head.
POLICY_CACHE_UNKNOWN_ENTRY | setup | Unknown file in policy cache | The cache directory holds a file the endpoint did not write.
POLICY_CACHE_WAIT_EXPIRED | busy | Policy cache wait timed out | Waiting for the cache lock took longer than 5 seconds.
POLICY_CACHE_WRITER_REQUIRED | busy | Policy cache writer missing | A write ran without holding the cache writer.
POLICY_CAPABILITY_EVIDENCE_UNAVAILABLE | policyServer | Required capability cannot be proven | The policy enforces required capabilities and no capability evidence exists yet.
POLICY_CLOCK_UNCERTAIN | policyPending | Device clock uncertain | Clock uncertainty exceeds the policy's offline limit.
POLICY_CUSTODY_GENERATION_UNAVAILABLE | policyServer | Signing key unavailable | The next signing key generation is not available (503).
POLICY_DELIVERY_BINDING | policyUntrusted | Policy delivery does not match | The bundle digest or root generation does not match the delivery.
POLICY_DELIVERY_SOURCES | policyUntrusted | Policy sources do not match | The compiled sources differ from the delivered sources.
POLICY_DESKTOP_PROJECTION_EXPIRED | policyPending | Desktop settings expired | The desktop policy projection has expired.
POLICY_DESKTOP_PROJECTION_UNBOUND | changed | Desktop settings do not match | The projection is not bound to this device's installed policy.
POLICY_DESKTOP_PROJECTION_WIDENED | blocked | Desktop settings wider than policy | The requested desktop settings exceed what the policy allows.
POLICY_DEVICE_GROUP_ASSIGNMENT_UNAVAILABLE | policyServer | Device group assignment unavailable | No policy assignment exists for this device group.
POLICY_ENROLLMENT_REQUIRED | notConnected | Not connected | Policy needs an enrollment certificate on this device.
POLICY_EVIDENCE_AUDIT_UNAVAILABLE | policyServer | Policy audit record missing | The audit row for this evidence was not found.
POLICY_EVIDENCE_CAPTURE_UNAVAILABLE | policyServer | Policy evidence capture unavailable | No evidence source is configured.
POLICY_EXCEPTION_UNAVAILABLE | policyServer | Policy exceptions not supported here | The bundle carries exceptions, which this endpoint cannot verify yet.
POLICY_EXCEPTION_VERIFICATION_UNAVAILABLE | policyServer | Policy exceptions cannot be verified | A policy references exceptions, which cannot be verified yet.
POLICY_HIGH_WATER_INVALID | setup | Policy history invalid | The installed revision history repeats a policy ID.
POLICY_HIGH_WATER_MISMATCH | policyUntrusted | Policy history does not match | A source's revision or digest differs from the recorded one.
POLICY_INSTALLED_ASSIGNMENT_CHANGED | policyPending | Policy changed during the update | The installed sources changed while the receipt was being sent.
POLICY_KEY_BINDING | policyServer | Signing key does not match | The key's tenant, generation or purpose does not match the document.
POLICY_NOT_EFFECTIVE | policyPending | Policy not in effect yet | A policy's effectiveAt is in the future.
POLICY_OPERATION | request | Unknown policy operation | Only provision, install and recover are accepted.
POLICY_PROVISION_BINDING | changed | Policy setup does not match | The provision marker names another binding or root.
POLICY_RECOVERY_ASSIGNMENT_CONFLICT | policyUntrusted | Recovered assignments conflict | Two recovered assignments share a revision with different content.
POLICY_RECOVERY_BINDING | policyUntrusted | Recovery answer does not match | The checkpoint names another tenant, enrollment or nonce.
POLICY_RECOVERY_EQUIVOCATION | policyUntrusted | Recovered policies conflict | The same revision was recovered with different content.
POLICY_RECOVERY_EVIDENCE_CORRUPT | setup | Recovery evidence damaged | An evidence file's name does not match its digest.
POLICY_RECOVERY_EVIDENCE_LIMIT | setup | Too much recovery evidence | The recovery directory holds over 512 entries.
POLICY_RECOVERY_FLOORS | policyUntrusted | Recovery floors invalid | A recovery checkpoint's revision floors are malformed.
POLICY_RECOVERY_HISTORY_UNAVAILABLE | policyServer | Policy history incomplete | The release ledger does not cover the enrollment's whole life (503).
POLICY_RECOVERY_POLICIES | policyUntrusted | Recovered policies invalid | A recovery checkpoint's policies are malformed.
POLICY_RECOVERY_REPLAY | policyUntrusted | Old recovery answer refused | The checkpoint sequence is not newer than the last one.
POLICY_RECOVERY_REQUEST_SIZE | setup | Recovery request too large | The recovery request exceeds its byte limit.
POLICY_RECOVERY_REVISION_CONFLICT | policyUntrusted | Recovered revisions conflict | A recovered revision went backwards or changed content.
POLICY_RECOVERY_SEQUENCE | policyUntrusted | Recovery sequence invalid | A checkpoint sequence is not a positive integer.
POLICY_RECOVERY_TENANT | policyUntrusted | Recovered policy belongs to another organization | A recovered policy names another tenant.
POLICY_RECOVERY_UNKNOWN_ENTRY | setup | Unknown recovery file | The recovery directory holds a file the endpoint did not write.
POLICY_RELEASE_LEDGER_BOUNDS | policyServer | Policy release ledger full | The ledger exceeds 4096 entries or 512 KiB.
POLICY_REVISION_ROLLBACK | policyUntrusted | Older policy revision refused | A policy revision went backwards or changed content.
POLICY_ROOT_UNPINNED | policyUntrusted | Policy root key not pinned | The policy root key does not match the device's pin.
POLICY_SIGNATURE_UNTRUSTED | policyUntrusted | Policy signature not trusted | A policy's signer is unknown or its signature fails.
POLICY_SIGNER_HISTORY_BOUNDS | policyServer | Signing key history invalid | The signer history is empty, over 129 entries, or does not start at generation 0.
POLICY_SIGNER_HISTORY | policyUntrusted | Signing key change not trusted | A signer transition repeats a key or fails verification.
POLICY_SIGNER_NOT_BOOTSTRAPPED | policyServer | Signing key not set up | The tenant has no policy signer yet.
POLICY_SIGNER_ROLLBACK | policyUntrusted | Signing key history rewritten | The delivered signer history does not extend the installed one.
POLICY_SIGNER_ROOT_UNTRUSTED | policyServer | Signing root not pinned | The tenant's signer root does not match the server's root pin.
POLICY_STOPPING | busy | Endpoint is stopping | Policy install was refused during shutdown.
POLICY_SYNCHRONIZATION_MISMATCH | policyPending | Policy out of date | The delivered policy differs from the installed one.
POLICY_TENANT_MISMATCH | policyServer | Policy delivery for another organization | The device actor's tenant differs from the delivery lane.
POLICY_TRANSPORT_OUTCOME_INVALID | policyServer | Policy delivery result unclear | The transport reported connected and released inconsistently.
POLICY_TRUST_DIRECTORY | setup | Policy trust directory unsafe | The trust directory is not owner-only.
POLICY_TRUST_FILE | setup | Policy trust file unsafe | The trust file is not a single-link owner-only file under 128 KiB.
POLICY_TRUST_SIZE | setup | Policy trust file too large | The trust file exceeds 128 KiB.
POLICY_TRUSTED_RECOVERY_REQUIRED | setup | Policy needs trusted recovery | A pinned setup found existing trust or policy state, which must be recovered, not reprovisioned.
POLICY_BUDGET_DOMAIN_CONFLICT | policyAuthoring | Budget rules conflict | Two budget rules cover the same domain differently.
POLICY_COMPILATION_BOUNDS | policyAuthoring | Policy too large | The compiled policy exceeds its limits.
POLICY_DESKTOP_FIELD_CONFLICT | policyAuthoring | Desktop settings conflict | Two policies set the same desktop field differently.
POLICY_DLP_RULE_BOUNDS | policyAuthoring | Too many data rules | The data rules exceed their limits.
POLICY_DLP_RULE_CONFLICT | policyAuthoring | Data rules conflict | Two data rules contradict each other.
POLICY_DUPLICATE_EXCEPTION_ID | policyAuthoring | Exception ID repeats | Two exceptions share an ID.
POLICY_DUPLICATE_RULE_ID | policyAuthoring | Rule ID repeats | Two rules share an ID.
POLICY_EXCEPTION_BINDING_MISMATCH | policyAuthoring | Exception does not match | An exception is bound to another policy or scope.
POLICY_EXCEPTION_UNTRUSTED | policyAuthoring | Exception not trusted | An exception's approval cannot be verified.
POLICY_INVALID_ASSIGNMENT | policyAuthoring | Policy assignment invalid | The assignment's scopes are malformed.
POLICY_PAYLOAD_TOO_LARGE_OR_INVALID | policyAuthoring | Policy invalid or too large | The policy document did not parse within its size limit.
POLICY_RESIDENCY_CONFLICT | policyAuthoring | Data residency rules conflict | Two policies require different residency.
POLICY_RETENTION_CONFLICT | policyAuthoring | Retention rules conflict | Two policies require different retention.
POLICY_ROOT_OR_DUPLICATE_ID | policyAuthoring | Policy root or ID invalid | The root policy is missing or a policy ID repeats.
POLICY_SCOPE_OR_ASSIGNMENT_MISMATCH | policyAuthoring | Policy does not match its assignment | A policy's scope differs from the active assignment; activate the policy again.
POLICY_SIMULATION_BOUNDS | policyAuthoring | Simulation too large | The simulation input exceeds its limits.
POLICY_UNTRUSTED | policyUntrusted | Policy not trusted | A policy failed signature verification while compiling.
RUNTIME_BINDING | runtime | Runtime could not register | The runtime host refused enrollment.
RUNTIME_JOURNAL | runtime | Runtime journal unavailable | The runtime host's journal did not load.
RUNTIME_LIBRARY | runtime | Runtime is missing a function | The runtime library lacks a required function.
RUNTIME_PIN | runtime | Runtime version not pinned | The runtime archive's sha256 differs from the configured pin.
RUNTIME_REBIND | runtime | Runtime already bound | The runtime library was bound twice.
RUNTIME_ROUTE_CONFIGURATION | setup | Runtime route settings invalid | The runtime route's time or poll limits are out of range.
RUNTIME_ROUTE_EFFECT_UNKNOWN | runtime | Result of the run is unknown | The runtime may or may not have acted; check the run before retrying.
RUNTIME_SOURCE_UNSUPPORTED | policyServer | Runtime source not supported | Only maestro_runtime sources are accepted.
RUNTIME_SOURCE | runtime | Runtime not available | The composed runtime source is unavailable.
ENDPOINT_RECEIPT_MISMATCH | changed | Endpoint receipt does not match | The runtime adapter's receipt differs from the endpoint's answer.
ENDPOINT_SESSION_CHANGED | changed | Endpoint session changed | The endpoint session changed under the runtime adapter.
policy_denied | blocked | Blocked by your organization's policy | The installed policy denied the operation.
INVALID_REQUEST | request | Request not accepted | HTTP 400.
`;
// Codes with their own text: code | audience | severity | title | explanation | likely cause |
// fix | advanced hint | action (optional). The endpoint's denial reasons, connect-flow outcomes
// and API error codes. revoked, grant_expired and unavailable say what Maestro says (MSX-01-02).
const specific = `
unauthenticated | user | warning | This Maestro is not approved on this device yet | The endpoint does not recognize this Maestro, so it refused the request. | This Maestro never connected, its registration expired, or its approval was removed. | Connect again from Maestro; if it keeps happening, ask your admin to check Requests. | Peer or registration authentication failed (401/403). | Connect again
revoked | user | error | Disconnected by your administrator | Your administrator disconnected this Maestro. Connect again to continue. | An admin revoked this Maestro's grant or the device's enrollment. | Connect again from Maestro. Ask your admin first if you do not know why. | Grant state revoked. | Connect again
grant_expired | user | warning | Connection expired | Your connection expired. Connect again to continue. | The grant was not renewed before it expired, often because the device was offline for a long time. | Connect again from Maestro. | Grant state expired. | Connect again
unavailable | user | warning | Endpoint unavailable | Maestro cannot reach the Mega-Maestro endpoint on this computer, or it cannot answer right now. Use Troubleshoot for details. | The endpoint service is not running, is restarting, or something it depends on is down. | Wait a moment and try again. If it keeps happening, restart the endpoint service or run mega-maestro-endpoint doctor. | Socket unreachable, or the endpoint answered denied unavailable (503).
disconnected | user | info | Disconnected | This Maestro was disconnected from your organization on this device. | Someone chose Disconnect in Maestro or on their People page. | Connect again from Maestro when you need it. | Grant state disconnected. | Connect again
unsupported_version | admin | error | Versions do not match | Maestro and the endpoint on this computer do not speak the same protocol version. | One of them was updated and the other was not. | Update Maestro and the endpoint to versions your organization supports. | No common local protocol version.
unsupported_capability | user | warning | Not supported on this device | The endpoint on this computer does not offer what this action needs. | The endpoint version or this device's policy does not include the capability. | Ask your admin whether this device should offer it, or update the endpoint. | The capability was not negotiated.
expired | user | warning | Expired | The request or session expired before it finished. | It waited too long, or the device was offline or asleep. | Start it again. | A request, registration, spool or connect request passed its expiry.
replay | user | warning | Already used | The endpoint refused a request it had already seen. | Maestro retried a request that had already been used once. | Try the action again from the start. | A nonce or challenge was consumed before.
invalid_request | user | warning | Request not understood | The request was malformed, so it was refused. | Maestro and the endpoint versions differ, or the input is out of range. | Update Maestro and try again. If it keeps happening, copy the diagnostic bundle for your admin. | Schema validation failed.
untrusted_clock | user | warning | Device clock cannot be trusted | The endpoint cannot trust this computer's clock, so it refused a time-limited action. | The clock was changed, or the device has not synchronized time since it was offline. | Turn on automatic time, go online, and try again. | Clock state is uncertain or a rollback was detected.
budget_exhausted | user | warning | Budget used up | Your organization's spending budget for this does not allow more right now. | The budget for this period is used up. | Wait for the next budget period, or ask your admin to raise the budget. | Budget reservation refused.
unknown_price | admin | warning | Price not known | The endpoint does not know the price of this model, so it cannot check the budget. | The price list on this device is older than the model in use. | Publish an updated price list in the console, then try again. | The request names a price revision the endpoint does not hold.
owner_unfenced | user | warning | Another Maestro holds this work | Another Maestro already claimed this workflow, so this one cannot act on it. | A second Maestro or a restarted run tried to take over the same workflow. | Wait for the other run to finish or release it, then try again. | Workflow claim conflicted (409).
unsupported_action | user | warning | Action not supported | This run does not support that action. | The run's kind does not offer pause, resume or cancel. | Use an action the run offers. | Run control action not offered.
stale_run | user | info | Run already changed | The run moved on before your action arrived. | The run finished, restarted or was changed by someone else. | Refresh and try again if it still applies. | Run process epoch differs.
state_conflict | user | info | Run is not in that state | The run is not in a state that allows this action. | It is already paused, resumed or finished. | Refresh to see its current state. | Run state does not allow the transition.
denied | user | warning | Request not approved | Your request was not approved. | An admin denied it, or the number picked in the browser did not match. | Try again, or ask your admin. | Connect request denied. | Try again
denied_by_admin | user | warning | Denied by an admin | An admin denied this connect request. | The admin did not recognize the device or request. | Ask your admin, then try again. | decision_reason denied_by_admin. | Try again
number_mismatch | user | warning | Number did not match | The number picked in the browser did not match the one Maestro showed twice, so the request was denied. | The wrong number was picked, or someone else is trying to approve a request you did not start. | Start again from Maestro and pick the number it shows. If you did not start a request, tell your admin. | Consent confirm failed after its retry (AR-3). | Try again
pin_mismatch | admin | error | Server identity does not match | The server's certificate authority is not the one the join link or managed configuration expects, so nothing was sent. | The link points to a different server, or the network is intercepting the connection. | Get a new join link from your admin. Do not connect on this network until it is checked. | Discovery issuerSha256 differs from the pin (AR-7).
discovery_not_found | user | warning | Organization not found | No Mega-Maestro server was found for this email domain. | The domain is not verified for any organization yet, or it was mistyped. | Check the email address, or use a join link or code from your admin. | No discovery document or TXT record.
discovery_untrusted | admin | error | Organization's server not trusted | The server found for this domain could not be verified, so nothing was sent. | Its TLS certificate is not trusted on this computer, or the discovery document is invalid. | Ask your admin to check the server certificate and the domain's DNS record. | Discovery TLS or document validation failed.
already_connected | user | info | Already connected | This device is already connected to your organization. | An earlier connect finished. | Nothing to do. Disconnect first if you want to connect to a different organization. | An enrollment already exists.
join_unavailable | user | warning | Join link not valid | This join link or team code can no longer be used. | It expired, was revoked, or reached its use limit. | Ask your admin for a new join link. | The join method is inactive.
connect_unavailable | user | warning | Server unavailable | Your organization's server did not answer. | The server or the network is down, or it is busy. | Check your network and try again in a few minutes. | Network failure or a transient HTTP status (429/5xx).
connect_refused | user | warning | Connect refused | Your organization's server refused to connect this device. | The request was not accepted, or approval did not return a certificate. | Connect again from Maestro; if it keeps happening, ask your admin to check Requests. | A non-transient HTTP status.
managed_config_untrusted | admin | error | Managed configuration not trusted | This computer's managed configuration file can be changed by other accounts, so it was ignored. | The file or its directory is not owned by an administrator, or others can write it. | Fix the file's owner and permissions as an administrator (owned by root, not writable by others). | The managed configuration's owner or mode failed the check (AR-15).
managed_config_absent | user | info | Not managed | This computer has no managed configuration, so you connect by email or link. | Your organization does not manage this computer's Maestro. | Connect with your work email or a join link. | No managed configuration file.
connect_capacity | user | warning | Too many pending requests | There are too many connect requests waiting already. | You have 3 pending requests, or your organization has 500 (AR-2). | Wait for an admin to decide your pending request, or let it expire, then try again. | Pending request cap reached.
count_changed | admin | info | The list changed | The requests changed after you selected them, so nothing was decided. | Another admin decided some of them, or new ones arrived. | Review the list again and repeat the decision. | expectedCount differs (AR-17).
new_device | admin | info | New device | This device has never connected to your organization before. | A person is connecting a computer for the first time, or someone is trying a device you do not know. | Approve it if the person and device are expected; deny it otherwise. | Request flag new_device: a device connect request, not a reconnection.
renamed | admin | warning | Renamed | This device asked under a different name than it used before. | The computer was renamed, or a request is trying to look like another device (AR-4, AR-5). | Check the previous name shown with the flag before approving. | Request flag renamed: the device handle changed.
second_device_for_person | admin | info | Second device for this person | This person already has another connected device. | They got a new computer or use more than one, or their account is being used on a device that is not theirs. | Confirm with the person that this device is theirs before approving. | Request flag second_device_for_person: the person holds a live grant on another enrollment.
repeated_denials | admin | warning | Denied before from this device | An earlier request from this device was denied. | The device was refused before and is asking again. | Read why the earlier request was denied before approving this one. | Request flag repeated_denials: a denied request exists for this device key.
unusual_location | admin | warning | Outside usual country | The request came from a country this person does not usually connect from. | The person is travelling, uses a VPN, or someone else is using their account. | Confirm with the person where they are before approving. | Request flag unusual_location.
version_outdated | admin | info | Maestro version is out of date | The device runs an older Maestro than your organization expects. | Maestro on that computer has not been updated. | Approve if you trust the device, then ask the person to update Maestro. | Request flag version_outdated.
different_network | admin | warning | Browser on a different network | The browser that confirmed this request was on a different network than the device. | The person approved from their phone or another network, or someone else is approving a request they did not start (AR-12). | Confirm with the person that they started this request; it is never auto-approved. | Request flag different_network: the confirming address is outside the device's /24 or /64.
number_retry | admin | warning | Number picked on the second try | The person picked the wrong number first and the right one on a second try. | A misclick, or someone guessing the number shown in Maestro (AR-13). | Confirm with the person that they started this request; it is never auto-approved. | Request flag number_retry: the number check took more than one attempt.
rate_limited | user | warning | Too many attempts | Too many attempts were made in a short time. | Repeated tries from this network, account or organization (AR-21). | Wait a minute and try again. | See the Retry-After header.
scope_revoked | user | warning | The approval behind this was withdrawn | The endpoint did not run the command because the approval it was sent under no longer holds. | The person who approved it lost the role or access, or the connection was revoked, before the command arrived. | Ask an administrator to approve the command again if it is still needed. | The command's scope failed the live authority recheck.
invalid_signature | admin | error | The device could not trust a message | The endpoint refused a command or policy update because its signature did not verify, so nothing changed. | The message was altered on the way, was signed with a key this device does not trust, or the device's trusted keys are out of date. | Send it again. If it keeps happening, check the signing keys in the console and ${doctor} on the device. | The signature did not verify against the pinned key.
execution_failed | user | error | The command was accepted but did not finish | The endpoint accepted the command, but the run failed while carrying it out. | The run ended with an error on the device. | Open the run to see why, then try again. | The command's execution settled as failed.
stale_revision | admin | info | The device already has a newer policy | The endpoint kept a newer policy and refused this older revision. | A newer revision was installed first, or this rollout arrived late. | Nothing to fix: the newer policy stays in force. Check the rollout if you expected this revision. | The revision is lower than the installed revision.
installation_failed | admin | error | The device could not install the policy | The endpoint checked the policy but failed while installing it, so it keeps running its previous policy. | The device could not write its policy store, or a part the policy needs is missing. | On the device, ${doctor}, fix what it reports, then roll the policy out again. | The install step failed after verification.
AUTHENTICATION_REQUIRED | user | warning | Sign in again | Your session ended. | You signed out, or the session expired. | Sign in again. | HTTP 401.
FORBIDDEN | user | warning | Not allowed | Your account is not allowed to do this here. | Your role does not include this permission for this team. | Ask an admin of this team for access. | HTTP 403.
NOT_FOUND | user | info | Not found | This item does not exist or you cannot see it. | It was deleted or renamed, or it belongs to a team you cannot read. | Go back and search for it again. | HTTP 404.
CONFLICT | user | info | Changed by someone else | This item changed since you opened it. | Someone else edited it at the same time. | Reload and make the change again. | HTTP 409.
UNAVAILABLE | user | warning | Service unavailable | The server cannot do this right now. | A service it depends on is down or restarting. | Try again in a few minutes. | HTTP 503.
INTERNAL_ERROR | admin | error | Something went wrong on the server | The server failed while handling this request. | A server bug or an unexpected state. | Try again. If it keeps happening, give your admin the request ID shown. | HTTP 500; search the API logs for the request ID.
`;

const rows = (table: string): string[][] =>
	table
		.trim()
		.split('\n')
		.map((line) => line.split(' | '));
const groups = new Map(rows(groupTable).map(([name, ...shared]) => [name, shared]));
const audiences: readonly string[] = ['user', 'admin'];
const severities: readonly string[] = ['info', 'warning', 'error'];

// Rows are checked once at load, so a malformed row fails every test that imports the catalog.
function entry(
	code: string,
	shared: string[],
	title: string,
	advancedHint: string,
	action?: string
): [string, Explanation] {
	const [audience, severity, explanation, likelyCause, fix] = shared;
	if (
		shared.length !== 5 ||
		!audiences.includes(audience ?? '') ||
		!severities.includes(severity ?? '') ||
		!advancedHint
	)
		throw new Error(`Malformed catalog row: ${code}`);
	return [
		code,
		{
			title,
			explanation: explanation as string,
			likelyCause: likelyCause as string,
			fix: fix as string,
			audience: audience as TroubleshootingAudience,
			severity: severity as TroubleshootingSeverity,
			advancedHint,
			...(action ? { action } : {}),
		},
	];
}

export const troubleshootingCatalog: Readonly<Record<string, Explanation>> = Object.freeze(
	Object.fromEntries([
		...rows(grouped).map(([code = '', group = '', title = '', hint = '', ...extra]) =>
			entry(code, extra.length ? [] : (groups.get(group) ?? []), title, hint)
		),
		...rows(specific).map(
			([
				code = '',
				audience = '',
				severity = '',
				title = '',
				explanation = '',
				likelyCause = '',
				fix = '',
				hint = '',
				action,
				...extra
			]) =>
				entry(
					code,
					extra.length ? [] : [audience, severity, explanation, likelyCause, fix],
					title,
					hint,
					action
				)
		),
	])
);

// Object.hasOwn, spelled for the ES2020 lib the renderer and the CLI compile against.
const hasOwn = (code: string): boolean =>
	Object.prototype.hasOwnProperty.call(troubleshootingCatalog, code);

const printable = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

/** Whether `code` has its own catalog entry (false: `explain()` answers the generic one). */
export function hasTroubleshootingEntry(code: string): boolean {
	return hasOwn(code);
}

/** The catalog entry for `code`, or a safe generic one. An unknown code is shown only when it looks like a code. */
export function explain(code: string): Explanation {
	if (hasOwn(code)) return troubleshootingCatalog[code];
	return {
		title: 'Something went wrong',
		explanation: 'Mega-Maestro refused this request with a code this version cannot explain yet.',
		likelyCause: 'A newer component reported a code this version does not know.',
		fix: 'Try again. If it keeps happening, copy the diagnostic bundle and send it to your admin.',
		audience: 'user',
		severity: 'error',
		advancedHint: printable.test(code) ? `Unknown code ${code}.` : 'Unknown code.',
	};
}
