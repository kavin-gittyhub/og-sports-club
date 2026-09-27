// API client. Auth headers come from the active auth provider (Clerk or dev).
const BASE = (import.meta.env.VITE_API_URL || '').replace(/\/$/, '') + '/api';

let authHeaders = async () => ({});
export function setAuthHeaderProvider(fn) {
  authHeaders = fn;
}

export class ApiError extends Error {
  constructor(status, message, code, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export async function api(path, { method = 'GET', body, signal, raw = false } = {}) {
  let res;
  try {
    res = await fetch(BASE + path, {
      method,
      signal,
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(await authHeaders()) },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    throw new ApiError(0, 'Network problem — please check your connection and try again.', 'NETWORK');
  }
  if (raw) {
    if (!res.ok) throw new ApiError(res.status, 'Request failed', 'HTTP');
    return res;
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new ApiError(res.status, data?.error?.message || 'Something went wrong. Please try again.', data?.error?.code, data?.error?.details);
  }
  return data;
}

/** Download a file from an authenticated endpoint. */
export async function download(path, filename) {
  const res = await api(path, { raw: true });
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
