export interface User {
  id: number;
  email: string;
  role: 'admin' | 'developer' | 'user';
  active?: boolean;
  auth_source?: 'local' | 'ldap';
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
  externalDomains?: { declared: string; approved: boolean }[];
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
  changePassword: (currentPassword: string, newPassword: string) =>
    request<{ ok: boolean }>('/api/auth/change-password', {
      method: 'POST',
      body: JSON.stringify({ currentPassword, newPassword }),
    }),

  listApps: () => request<{ apps: AppInfo[] }>('/api/apps'),
  createApp: (name: string, description: string) =>
    request<{ app: { id: number; slug: string } }>('/api/apps', {
      method: 'POST',
      body: JSON.stringify({ name, description }),
    }),
  getApp: (slug: string) => request<{ app: AppInfo }>(`/api/apps/${slug}`),
  updateApp: (slug: string, patch: { visibility?: 'public' | 'private'; description?: string }) =>
    request<{ app: AppInfo }>(`/api/apps/${slug}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  members: (slug: string) =>
    request<{ members: { user_id: number; email: string; added_at: string }[] }>(
      `/api/apps/${slug}/members`,
    ),
  addMember: (slug: string, email: string) =>
    request<{ member: { user_id: number; email: string } }>(`/api/apps/${slug}/members`, {
      method: 'POST',
      body: JSON.stringify({ email }),
    }),
  removeMember: (slug: string, userId: number) =>
    request<{ ok: boolean }>(`/api/apps/${slug}/members/${userId}`, { method: 'DELETE' }),
  versions: (slug: string) => request<{ versions: Version[] }>(`/api/apps/${slug}/versions`),
  activate: (slug: string, id: number) =>
    request<{ ok: boolean }>(`/api/apps/${slug}/versions/${id}/activate`, { method: 'POST' }),
  deleteApp: (slug: string) =>
    request<{ ok: boolean }>(`/api/apps/${slug}`, { method: 'DELETE' }),
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
  setUserActive: (id: number, active: boolean) =>
    request<{ user: User }>(`/api/admin/users/${id}/active`, {
      method: 'PUT',
      body: JSON.stringify({ active }),
    }),
  resetPassword: (id: number, newPassword: string) =>
    request<{ ok: boolean }>(`/api/admin/users/${id}/reset-password`, {
      method: 'POST',
      body: JSON.stringify({ newPassword }),
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

  dbConfig: () => request<{ config: DbLimits }>('/api/db-config'),
  updateDbConfig: (config: DbLimits) =>
    request<{ config: DbLimits }>('/api/db-config', { method: 'PUT', body: JSON.stringify(config) }),
  dbOverview: () => request<{ databases: DbOverviewRow[] }>('/api/admin/db-overview'),
  appDatabase: (slug: string) =>
    request<{ database: { slug: string; exists: boolean; sizeBytes: number; updatedAt: string | null } }>(
      `/api/admin/apps/${slug}/database`,
    ),
  resetDatabase: (slug: string) =>
    request<{ ok: boolean }>(`/api/admin/apps/${slug}/database/reset`, {
      method: 'POST',
      body: JSON.stringify({ confirm: true }),
    }),

  metrics: (days: number) =>
    request<MetricsView>(`/api/admin/metrics?days=${days}`),

  ldapConfig: () => request<{ config: LdapConfigView }>('/api/ldap-config'),  updateLdapConfig: (c: Omit<LdapConfigView, 'bindPasswordMasked'> & { bindPassword?: string }) =>
    request<{ config: LdapConfigView }>('/api/ldap-config', { method: 'PUT', body: JSON.stringify(c) }),
  testLdap: (login?: string, password?: string) =>
    request<LdapTestResult>('/api/ldap-config/test', {
      method: 'POST',
      body: JSON.stringify({ login, password }),
    }),
  externalDomains: () =>
    request<{ domains: { domain: string; note: string; created_at: string }[] }>(
      '/api/admin/external-domains',
    ),
  addExternalDomain: (domain: string, note: string) =>
    request<{ domain: string }>('/api/admin/external-domains', {
      method: 'POST',
      body: JSON.stringify({ domain, note }),
    }),
  removeExternalDomain: (domain: string) =>
    request<{ ok: boolean }>(`/api/admin/external-domains/${encodeURIComponent(domain)}`, {
      method: 'DELETE',
    }),
};

export interface DbLimits {
  quotaMb: number;
  timeoutMs: number;
  maxRows: number;
  rateLimitPerMin: number;
}

export interface DbOverviewRow {
  slug: string;
  name: string;
  exists: boolean;
  sizeBytes: number;
  updatedAt: string | null;
}

export function databaseDownloadUrl(slug: string): string {
  return `/api/admin/apps/${slug}/database/download`;
}

export interface LdapConfigView {
  enabled: boolean;
  mode: 'ldaps' | 'starttls';
  url: string;
  baseDn: string;
  bindMode: 'service' | 'direct';
  bindDn: string;
  bindPasswordMasked: string;
  userDnPattern: string;
  userFilter: string;
  mailAttr: string;
  groupAttr: string;
  tlsSkipVerify: boolean;
  roleMappings: { group: string; role: 'admin' | 'developer' | 'user' }[];
  defaultRole: 'admin' | 'developer' | 'user';
}

export interface LdapTestResult {
  ok: boolean;
  steps: { step: string; ok: boolean; detail: string }[];
  role?: string;
  email?: string;
}

export interface MetricsView {
  days: number;
  summary: {
    loginOkLocal: number;
    loginOkLdap: number;
    loginFail: number;
    publishOk: number;
    publishRejected: number;
    dbQueries: number;
    appAccess: number;
  };
  apps: { slug: string; access: number; dbQueries: number; publishOk: number; publishRejected: number }[];
}
