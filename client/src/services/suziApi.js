// Suzi desktop (DEF-370): Settings → Suzi desktop. The server takes the person and the tenant from
// the session (req.user); nothing identifying is ever sent from here.
import api from './api';

const BASE = '/v1/suzi';

export function errorText(e) {
  return e?.response?.data?.error ?? e?.response?.data?.message ?? e?.message ?? 'Unknown error';
}

export async function createConnectKey() {
  const { data } = await api.post(`${BASE}/connect-key`);
  return data; // { key, expiresAt, serverUrl, connectLink }
}

export async function listDevices() {
  const { data } = await api.get(`${BASE}/devices`);
  return Array.isArray(data?.devices) ? data.devices : [];
}

export async function disconnectDevice(id) {
  await api.delete(`${BASE}/devices/${encodeURIComponent(id)}`);
}
