export interface User {
  id: number;
  email: string;
  role: 'admin' | 'developer' | 'user';
}

export interface AppInfo {
  id: number;
  slug: string;
  name: string;
  description: string;
  owner_id: number;
  visibility: 'public' | 'private';
  owner_email: string;
  current_version: string | null;
}

export interface Version {
  id: number;
  version: string;
  bundle_hash: string;
  status: 'published' | 'active';
  created_at: string;
}

export interface Finding {
  rule: string;
  severity: 'critical' | 'high' | 'medium' | 'low' | 'info';
  file: string;
  line: number;
  snippet?: string;
  message: string;
  fix: string;
}

export interface PublishOutcome {
  verdict: 'published' | 'rejected';
  attemptId: number;
  version?: string;
  findings: Finding[];
  summary: Record<string, number>;
  meta?: {
    llm?: {
      provider: string;
      model: string;
      reviewed: number;
      cached: number;
      skipped: number;
      available: boolean;
    };
  };
}

export interface LlmConfigView {
  enabled: boolean;
  provider: 'openai' | 'anthropic';
  baseUrl: string;
  model: string;
  apiKeyMasked: string;
  onUnavailable: 'continue' | 'block';
}

export interface Attempt {
  id: number;
  verdict: 'published' | 'rejected';
  created_at: string;
  app_slug?: string;
  app_name?: string;
  user_email?: string;
  version?: string | null;
  bundle_hash?: string;
  findings?: Finding[];
  app_id?: number;
}

export class ApiError extends Error {
  status: number;
  body: unknown;
  constructor(status: number, message: string, body: unknown) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

async function request<T>(path: string, opts: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    credentials: 'same-origin',
    // Sin cuerpo no va Content-Type: un POST con JSON vacío es rechazado por Fastify con 400
    headers:
      opts.body instanceof FormData
        ? undefined
        : opts.body !== undefined
          ? { 'Content-Type': 'application/json' }
          : undefined,
    ...opts,
  });
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    // respuestas 204 sin cuerpo
  }
  if (!res.ok) {
    const message =
      body && typeof body === 'object' && 'error' in body
        ? String((body as { error: unknown }).error)
        : `Error ${res.status}`;
    throw new ApiError(res.status, message, body);
  }
  return body as T;
}

export const api = {
  config: () => request<{ appsUrlTemplate: string }>('/api/config'),
  me: () => request<{ user: User | null }>('/api/auth/me'),
  login: (email: string, password: string) =>
    request<{ user: User }>('/api/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) }),
  register: (email: string, password: string) =>
    request<{ user: User }>('/api/auth/register', { method: 'POST', body: JSON.stringify({ email, password }) }),
  logout: () => request<{ ok: boolean }>('/api/auth/logout', { method: 'POST' }),

  listApps: () => request<{ apps: AppInfo[] }>('/api/apps'),
  createApp: (name: string, description: string) =>
    request<{ app: { id: number; slug: string } }>('/api/apps', {
      method: 'POST',
      body: JSON.stringify({ name, description }),
    }),
  getApp: (slug: string) => request<{ app: AppInfo }>(`/api/apps/${slug}`),
  versions: (slug: string) => request<{ versions: Version[] }>(`/api/apps/${slug}/versions`),
  activate: (slug: string, id: number) =>
    request<{ ok: boolean }>(`/api/apps/${slug}/versions/${id}/activate`, { method: 'POST' }),
  publish: (slug: string, file: File) => {
    const form = new FormData();
    form.append('bundle', file, file.name);
    return request<PublishOutcome>(`/api/apps/${slug}/publish`, { method: 'POST', body: form });
  },

  appAttempts: (slug: string) => request<{ attempts: Attempt[] }>(`/api/apps/${slug}/attempts`),
  attempts: () => request<{ attempts: Attempt[] }>('/api/attempts'),
  attempt: (id: number) => request<{ attempt: Attempt }>(`/api/attempts/${id}`),

  users: () => request<{ users: User[] }>('/api/admin/users'),
  createUser: (email: string, password: string, role: string) =>
    request<{ user: User }>('/api/admin/users', {
      method: 'POST',
      body: JSON.stringify({ email, password, role }),
    }),
  policy: () =>
    request<{ policy: { blockSeverities: string[]; maxBundleMb: number; maxFiles: number } }>('/api/policy'),
  updatePolicy: (policy: { blockSeverities: string[]; maxBundleMb: number; maxFiles: number }) =>
    request<{ policy: { blockSeverities: string[]; maxBundleMb: number; maxFiles: number } }>('/api/policy', {
      method: 'PUT',
      body: JSON.stringify(policy),
    }),

  llmConfig: () => request<{ config: LlmConfigView }>('/api/llm-config'),
  updateLlmConfig: (c: {
    enabled: boolean;
    provider: string;
    baseUrl: string;
    model: string;
    apiKey?: string;
    onUnavailable: string;
  }) =>
    request<{ config: LlmConfigView }>('/api/llm-config', {
      method: 'PUT',
      body: JSON.stringify(c),
    }),
};
