import { create } from 'zustand';
import * as api from '@renderer/lib/admin-api.js';

interface AdminState {
  // ── Data ──────────────────────────────────────────────────────────────────
  dashboardStats: api.DashboardStats | null;

  modelsConfig: unknown | null;
  providers: unknown[];

  channels: unknown[];

  tools: unknown[];

  consciousnessModules: unknown[];
  thoughts: unknown[];

  cronJobs: unknown[];

  settings: unknown | null;

  apiTokens: unknown[];
  corsOrigins: string[];

  logEntries: unknown[];

  sessions: unknown[];

  systemInfo: unknown | null;

  // ── Loading / error state ──────────────────────────────────────────────────
  loading: Record<string, boolean>;
  errors: Record<string, string | null>;

  // ── Actions ───────────────────────────────────────────────────────────────
  fetchDashboard: () => Promise<void>;
  fetchModels: () => Promise<void>;
  fetchChannels: () => Promise<void>;
  fetchTools: () => Promise<void>;
  fetchConsciousness: () => Promise<void>;
  fetchCron: () => Promise<void>;
  fetchSettings: () => Promise<void>;
  fetchSecurity: () => Promise<void>;
  fetchLogs: (level?: string, search?: string) => Promise<void>;
  fetchSessions: () => Promise<void>;
  fetchSystem: () => Promise<void>;
}

function setLoading(
  set: (fn: (s: AdminState) => Partial<AdminState>) => void,
  key: string,
  value: boolean,
) {
  set((s) => ({ loading: { ...s.loading, [key]: value } }));
}

function setError(
  set: (fn: (s: AdminState) => Partial<AdminState>) => void,
  key: string,
  error: string | null,
) {
  set((s) => ({ errors: { ...s.errors, [key]: error } }));
}

export const useAdminStore = create<AdminState>((set) => ({
  // ── Initial state ──────────────────────────────────────────────────────────
  dashboardStats: null,

  modelsConfig: null,
  providers: [],

  channels: [],

  tools: [],

  consciousnessModules: [],
  thoughts: [],

  cronJobs: [],

  settings: null,

  apiTokens: [],
  corsOrigins: [],

  logEntries: [],

  sessions: [],

  systemInfo: null,

  loading: {},
  errors: {},

  // ── fetchDashboard ─────────────────────────────────────────────────────────
  fetchDashboard: async () => {
    setLoading(set, 'dashboard', true);
    setError(set, 'dashboard', null);
    try {
      const dashboardStats = await api.fetchDashboardStats();
      set({ dashboardStats });
    } catch (e) {
      setError(set, 'dashboard', String(e));
    } finally {
      setLoading(set, 'dashboard', false);
    }
  },

  // ── fetchModels ────────────────────────────────────────────────────────────
  fetchModels: async () => {
    setLoading(set, 'models', true);
    setError(set, 'models', null);
    try {
      const [modelsConfig, providers] = await Promise.all([
        api.fetchModelsConfig(),
        api.fetchProviders(),
      ]);
      set({
        modelsConfig,
        providers: Array.isArray(providers) ? providers : [],
      });
    } catch (e) {
      setError(set, 'models', String(e));
    } finally {
      setLoading(set, 'models', false);
    }
  },

  // ── fetchChannels ──────────────────────────────────────────────────────────
  fetchChannels: async () => {
    setLoading(set, 'channels', true);
    setError(set, 'channels', null);
    try {
      const channels = await api.fetchChannels();
      set({ channels: Array.isArray(channels) ? channels : [] });
    } catch (e) {
      setError(set, 'channels', String(e));
    } finally {
      setLoading(set, 'channels', false);
    }
  },

  // ── fetchTools ─────────────────────────────────────────────────────────────
  fetchTools: async () => {
    setLoading(set, 'tools', true);
    setError(set, 'tools', null);
    try {
      const tools = await api.fetchTools();
      set({ tools: Array.isArray(tools) ? tools : [] });
    } catch (e) {
      setError(set, 'tools', String(e));
    } finally {
      setLoading(set, 'tools', false);
    }
  },

  // ── fetchConsciousness ─────────────────────────────────────────────────────
  fetchConsciousness: async () => {
    setLoading(set, 'consciousness', true);
    setError(set, 'consciousness', null);
    try {
      const [consciousnessModules, thoughts] = await Promise.all([
        api.fetchConsciousnessModules(),
        api.fetchThoughts(),
      ]);
      set({
        consciousnessModules: Array.isArray(consciousnessModules)
          ? consciousnessModules
          : [],
        thoughts: Array.isArray(thoughts) ? thoughts : [],
      });
    } catch (e) {
      setError(set, 'consciousness', String(e));
    } finally {
      setLoading(set, 'consciousness', false);
    }
  },

  // ── fetchCron ──────────────────────────────────────────────────────────────
  fetchCron: async () => {
    setLoading(set, 'cron', true);
    setError(set, 'cron', null);
    try {
      const cronJobs = await api.fetchCronJobs();
      set({ cronJobs: Array.isArray(cronJobs) ? cronJobs : [] });
    } catch (e) {
      setError(set, 'cron', String(e));
    } finally {
      setLoading(set, 'cron', false);
    }
  },

  // ── fetchSettings ──────────────────────────────────────────────────────────
  fetchSettings: async () => {
    setLoading(set, 'settings', true);
    setError(set, 'settings', null);
    try {
      const settings = await api.fetchSettings();
      set({ settings });
    } catch (e) {
      setError(set, 'settings', String(e));
    } finally {
      setLoading(set, 'settings', false);
    }
  },

  // ── fetchSecurity ──────────────────────────────────────────────────────────
  fetchSecurity: async () => {
    setLoading(set, 'security', true);
    setError(set, 'security', null);
    try {
      const [apiTokens, corsData] = await Promise.all([
        api.fetchApiTokens(),
        api.fetchCorsOrigins(),
      ]);
      const corsOrigins =
        corsData != null &&
        typeof corsData === 'object' &&
        'origins' in corsData &&
        Array.isArray((corsData as { origins: unknown }).origins)
          ? ((corsData as { origins: string[] }).origins)
          : Array.isArray(corsData)
            ? (corsData as string[])
            : [];
      set({
        apiTokens: Array.isArray(apiTokens) ? apiTokens : [],
        corsOrigins,
      });
    } catch (e) {
      setError(set, 'security', String(e));
    } finally {
      setLoading(set, 'security', false);
    }
  },

  // ── fetchLogs ──────────────────────────────────────────────────────────────
  fetchLogs: async (level?: string, search?: string) => {
    setLoading(set, 'logs', true);
    setError(set, 'logs', null);
    try {
      const logEntries = await api.fetchLogs(level, search);
      set({ logEntries: Array.isArray(logEntries) ? logEntries : [] });
    } catch (e) {
      setError(set, 'logs', String(e));
    } finally {
      setLoading(set, 'logs', false);
    }
  },

  // ── fetchSessions ──────────────────────────────────────────────────────────
  fetchSessions: async () => {
    setLoading(set, 'sessions', true);
    setError(set, 'sessions', null);
    try {
      const sessions = await api.fetchSessions();
      set({ sessions: Array.isArray(sessions) ? sessions : [] });
    } catch (e) {
      setError(set, 'sessions', String(e));
    } finally {
      setLoading(set, 'sessions', false);
    }
  },

  // ── fetchSystem ────────────────────────────────────────────────────────────
  fetchSystem: async () => {
    setLoading(set, 'system', true);
    setError(set, 'system', null);
    try {
      const systemInfo = await api.fetchSystemInfo();
      set({ systemInfo });
    } catch (e) {
      setError(set, 'system', String(e));
    } finally {
      setLoading(set, 'system', false);
    }
  },
}));
