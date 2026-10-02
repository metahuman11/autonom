import { xAccountOf } from './x-posts.mjs';

// A fresh controller acknowledgment is not an isolation attestation or permission.
// It only describes which already-authorized workflows the running controller has.
export const RUNTIME_CAPABILITY_VERSION = 1;
export const RUNTIME_HEARTBEAT_MAX_AGE_MS = 180_000;
const fail = message => Object.assign(new Error(message), { status: 400 });

export function acknowledgeRuntime(t, raw, now = Date.now()) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) ||
      Object.keys(raw).sort().join(',') !== 'execution,files,preview,version' ||
      raw.version !== RUNTIME_CAPABILITY_VERSION ||
      typeof raw.files !== 'boolean' || typeof raw.preview !== 'boolean' ||
      raw.execution !== false || (raw.preview && !raw.files)) {
    throw fail('invalid controller capabilities; terminal execution is unavailable');
  }
  return { version: raw.version, files: raw.files, preview: raw.preview, execution: false,
    acknowledgedAt: new Date(now).toISOString(), registration: t.vps?.registeredAt || null };
}

export function runtimeCapabilitiesOf(t, now = Date.now()) {
  const v = t.vps || {}, a = t.agent || {}, c = v.runtimeCapabilities;
  const heartbeat = Date.parse(a.lastHeartbeatAt || '');
  const acknowledgment = Date.parse(c?.acknowledgedAt || '');
  const fresh = at => Number.isFinite(at) && at <= now + 5_000 && now - at <= RUNTIME_HEARTBEAT_MAX_AGE_MS;
  const running = v.state === 'running';
  const online = running && ['starting', 'idle', 'working'].includes(a.state) && fresh(heartbeat);
  const acknowledged = c?.version === RUNTIME_CAPABILITY_VERSION && fresh(acknowledgment) &&
    c.registration === (v.registeredAt || null);
  const enabled = v.workbenchEnabled === true;
  const files = online && enabled && acknowledged && c.files === true;
  const preview = files && c.preview === true;
  return {
    version: RUNTIME_CAPABILITY_VERSION, online, acknowledged: Boolean(acknowledged),
    chat: online, files, preview, execution: false,
    status: !running ? 'stopped' : !online ? 'waiting_for_heartbeat' : 'online',
    workbenchStatus: !enabled ? 'disabled' : !online ? 'agent_offline' :
      !acknowledged ? 'awaiting_controller' : files ? 'file_tools_available' : 'unavailable',
    previewKind: 'temporary_static_page',
    executionReason: 'verified_execution_isolation_unavailable',
    social: xAccountOf(t) ? 'account_assigned' : 'not_connected', dexPayments: 'not_connected',
  };
}
