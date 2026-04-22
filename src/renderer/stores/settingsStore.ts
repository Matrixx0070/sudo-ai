import { create } from 'zustand';
import { ipcInvoke } from '@renderer/lib/ipc-client';

export interface ApiKeys {
  anthropic: string;
  openai: string;
  xai: string;
  google: string;
  youtube: string;
}

export interface ModelConfig {
  primary: string;
  fallback: string;
  temperature: number;
  maxTokens: number;
}

export interface ChannelConfig {
  id: string;
  name: string;
  type: 'quiz' | 'compare' | 'sleep' | 'news' | 'custom';
  enabled: boolean;
  uploadSchedule: string;
}

interface SettingsState {
  apiKeys: ApiKeys;
  modelConfig: ModelConfig;
  channels: ChannelConfig[];
  loaded: boolean;

  setApiKey: (key: keyof ApiKeys, value: string) => void;
  setModelConfig: (config: Partial<ModelConfig>) => void;
  setChannels: (channels: ChannelConfig[]) => void;
  save: () => Promise<void>;
  load: () => Promise<void>;
}

const DEFAULT_KEYS: ApiKeys = {
  anthropic: '',
  openai: '',
  xai: '',
  google: '',
  youtube: '',
};

const DEFAULT_MODEL: ModelConfig = {
  primary: 'claude-sonnet-4-6',
  fallback: 'gpt-4o-mini',
  temperature: 0.7,
  maxTokens: 8192,
};

export const useSettingsStore = create<SettingsState>((set, get) => ({
  apiKeys: DEFAULT_KEYS,
  modelConfig: DEFAULT_MODEL,
  channels: [],
  loaded: false,

  setApiKey: (key, value) =>
    set((state) => ({ apiKeys: { ...state.apiKeys, [key]: value } })),

  setModelConfig: (config) =>
    set((state) => ({ modelConfig: { ...state.modelConfig, ...config } })),

  setChannels: (channels) => set({ channels }),

  save: async () => {
    const { apiKeys, modelConfig, channels } = get();
    await ipcInvoke('settings:set', { apiKeys, modelConfig, channels });
  },

  load: async () => {
    const data = await ipcInvoke<{
      apiKeys?: ApiKeys;
      modelConfig?: ModelConfig;
      channels?: ChannelConfig[];
    }>('settings:get');

    if (data) {
      set({
        apiKeys: data.apiKeys ?? DEFAULT_KEYS,
        modelConfig: data.modelConfig ?? DEFAULT_MODEL,
        channels: data.channels ?? [],
        loaded: true,
      });
    } else {
      set({ loaded: true });
    }
  },
}));
