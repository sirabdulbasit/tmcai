// Suzi desktop (DEF-370): Settings → Suzi desktop. The server takes the person and the tenant from
// the session (req.user); nothing identifying is ever sent from here.
import api from './api';

const BASE = '/v1/suzi';

export function errorText(e) {
  return e?.response?.data?.error ?? e?.response?.data?.message ?? e?.message ?? 'Unknown error';
}

/** The signed-in person's own API key, valid for `validityDays` (7, 30 or 90). Shown once. */
export async function createApiKey(validityDays = 30) {
  const { data } = await api.post(`${BASE}/api-key`, { validityDays });
  return data; // { apiKey, keyPrefix, expiresAt, validityDays, serverUrl, connectLink }
}

export async function listDevices() {
  const { data } = await api.get(`${BASE}/devices`);
  return Array.isArray(data?.devices) ? data.devices : [];
}

export async function disconnectDevice(id) {
  await api.delete(`${BASE}/devices/${encodeURIComponent(id)}`);
}
