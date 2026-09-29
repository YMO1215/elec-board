// JSON API client. Paths are relative ("api/...") so the app also works
// when served under a gateway prefix.

export class ApiError extends Error {
  constructor(status, code, message, detail) {
    super(message);
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
  get offline() {
    return this.status === 0;
  }
}

let csrfToken = null;
const listeners = new Set();

export function setCsrf(token) {
  csrfToken = token;
}

/** Called with the ApiError whenever the session is gone (401). */
export function onUnauthorized(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function qs(params = {}) {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : "";
}

export async function request(path, { method = "GET", body, form, params, signal, quiet401 = false } = {}) {
  const headers = {};
  let payload;
  if (method !== "GET" && csrfToken) headers["X-CSRF-Token"] = csrfToken;
  if (form) {
    payload = form;
  } else if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    payload = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(path + qs(params), { method, headers, body: payload, credentials: "same-origin", signal });
  } catch (err) {
    if (err.name === "AbortError") throw err;
    throw new ApiError(0, "offline", "서버에 연결할 수 없습니다. 네트워크를 확인하세요.");
  }
  const type = res.headers.get("content-type") || "";
  let data = null;
  if (type.includes("application/json")) {
    try {
      data = await res.json();
    } catch (err) {
      // Navigating away aborts the body read: that must stay an abort, not become `null` data.
      if (err.name === "AbortError" || signal?.aborted) throw new DOMException("aborted", "AbortError");
      if (res.ok) throw new ApiError(res.status, "bad_response", "서버 응답을 읽지 못했습니다. 다시 시도하세요.");
    }
  }
  if (!res.ok) {
    const e = (data && data.error) || {};
    const err = new ApiError(res.status, e.code || `http_${res.status}`, e.message || `요청이 실패했습니다 (${res.status}).`, e.detail);
    if (res.status === 401 && !quiet401) listeners.forEach((fn) => fn(err));
    throw err;
  }
  return data;
}

export const api = {
  get: (path, params, opts = {}) => request(path, { ...opts, params }),
  post: (path, body, opts = {}) => request(path, { ...opts, method: "POST", body }),
  patch: (path, body, opts = {}) => request(path, { ...opts, method: "PATCH", body }),
  put: (path, body, opts = {}) => request(path, { ...opts, method: "PUT", body }),
  del: (path, opts = {}) => request(path, { ...opts, method: "DELETE" }),
  upload: (path, form, opts = {}) => request(path, { ...opts, method: "POST", form }),
};
