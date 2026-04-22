import { create } from 'zustand';

export interface RevenueDataPoint {
  date: string;
  amount: number;
}

export interface CronJob {
  id: string;
  name: string;
  schedule: string;
  lastRun: string | null;
  nextRun: string | null;
  status: 'active' | 'paused' | 'error';
}

export interface ActivityEntry {
  id: string;
  type: 'video' | 'pipeline' | 'skill' | 'system';
  description: string;
  timestamp: number;
}

export interface SystemMetrics {
  cpuPercent: number;
  memoryPercent: number;
  diskPercent: number;
  uptime: number;
}

interface DashboardState {
  totalViews: number;
  viewsChange: number;
  revenue: number;
  revenueChange: number;
  videosProduced: number;
  videosChange: number;
  systemHealth: number;
  revenueHistory: RevenueDataPoint[];
  recentActivity: ActivityEntry[];
  cronJobs: CronJob[];
  systemMetrics: SystemMetrics;

  updateMetrics: (metrics: Partial<DashboardState>) => void;
  setSystemMetrics: (metrics: SystemMetrics) => void;
  addActivity: (entry: ActivityEntry) => void;
  setCronJobs: (jobs: CronJob[]) => void;
}

const DEMO_REVENUE: RevenueDataPoint[] = [
  { date: 'Mar 19', amount: 42 },
  { date: 'Mar 20', amount: 58 },
  { date: 'Mar 21', amount: 51 },
  { date: 'Mar 22', amount: 73 },
  { date: 'Mar 23', amount: 69 },
  { date: 'Mar 24', amount: 85 },
  { date: 'Mar 25', amount: 91 },
  { date: 'Mar 26', amount: 78 },
];

export const useDashboardStore = create<DashboardState>((set) => ({
  totalViews: 142_380,
  viewsChange: 12.4,
  revenue: 847,
  revenueChange: 8.2,
  videosProduced: 34,
  videosChange: 6,
  systemHealth: 98,
  revenueHistory: DEMO_REVENUE,
  recentActivity: [],
  cronJobs: [],
  systemMetrics: {
    cpuPercent: 0,
    memoryPercent: 0,
    diskPercent: 0,
    uptime: 0,
  },

  updateMetrics: (metrics) => set((state) => ({ ...state, ...metrics })),

  setSystemMetrics: (metrics) => set({ systemMetrics: metrics }),

  addActivity: (entry) =>
    set((state) => ({
      recentActivity: [entry, ...state.recentActivity].slice(0, 50),
    })),

  setCronJobs: (jobs) => set({ cronJobs: jobs }),
}));
