import type { Role } from '../../../campus/types';
export interface SessionUser { id: string; username: string; name: string; role: Role; teacherId?: string; lastLoginAt?: string }
export class ApiError extends Error { constructor(message: string, readonly status: number) { super(message); } }
async function http<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, { method, headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const json = await response.json().catch(() => ({ error: 'The bridge could not complete this request.' }));
  if (!response.ok) throw new ApiError(String(json.error ?? 'The bridge could not complete this request.'), response.status);
  return json as T;
}
/** Session-authenticated bridge call. Authority comes from the signed-in account, never from client-declared roles. */
export async function request<T>(path: string, body?: unknown): Promise<T> { return http<T>(body === undefined ? 'GET' : 'POST', path, body); }
export const auth = {
  me: () => http<{ user: SessionUser | null }>('GET', '/api/auth/me'),
  login: (username: string, password: string) => http<{ user: SessionUser; expiresAt: string }>('POST', '/api/auth/login', { username, password }),
  logout: () => http<{ ok: boolean }>('POST', '/api/auth/logout', {}),
  changePassword: (current: string, next: string) => http<{ ok: boolean }>('POST', '/api/auth/password', { current, next }),
  createUser: (input: { username: string; name: string; role: string; password: string; teacherId?: string }) => http<{ user: SessionUser }>('POST', '/api/auth/create', input),
  listUsers: () => http<{ users: SessionUser[] }>('GET', '/api/auth/list'),
};
export function download(name: string, content: string, type = 'application/json') { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([content], { type })); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000); }
