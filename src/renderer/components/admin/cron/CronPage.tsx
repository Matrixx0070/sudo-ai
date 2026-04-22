import React, { useEffect, useState, useCallback } from 'react';
import { DataTable } from '@renderer/components/common/DataTable.js';
import { StatusDot } from '@renderer/components/common/StatusDot.js';
import { SearchInput } from '@renderer/components/common/SearchInput.js';
import { Toggle } from '@renderer/components/common/Toggle.js';
import { ConfirmDialog } from '@renderer/components/common/ConfirmDialog.js';
import { Spinner } from '@renderer/components/common/Spinner.js';
import * as api from '@renderer/lib/admin-api.js';

// ─── Types ────────────────────────────────────────────────────────────────────

interface CronJob {
  id: string;
  name: string;
  schedule: string;
  enabled: boolean;
  lastRun: string | null;
  nextRun: string | null;
  consecutiveErrors: number;
}

type ScheduleType = 'cron' | 'interval' | 'time';

interface FormState {
  name: string;
  scheduleType: ScheduleType;
  scheduleValue: string;
  handler: string;
  enabled: boolean;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return isNaN(d.getTime()) ? '—' : d.toLocaleString();
}

function buildSchedule(type: ScheduleType, value: string): string {
  if (type === 'cron') return value;
  if (type === 'interval') return `*/${value} * * * *`;
  // time: HH:MM
  const [h, m] = value.split(':');
  return `${m ?? '0'} ${h ?? '0'} * * *`;
}

function emptyForm(): FormState {
  return { name: '', scheduleType: 'cron', scheduleValue: '', handler: '', enabled: true };
}

// ─── JobForm ─────────────────────────────────────────────────────────────────

interface JobFormProps {
  initial: FormState;
  editingId: string | null;
  onSave: (form: FormState) => Promise<void>;
  onCancel: () => void;
}

function JobForm({ initial, editingId, onSave, onCancel }: JobFormProps) {
  const [form, setForm] = useState<FormState>(initial);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  function set<K extends keyof FormState>(k: K, v: FormState[K]) {
    setForm(f => ({ ...f, [k]: v }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.name.trim() || !form.scheduleValue.trim() || !form.handler.trim()) {
      setErr('Name, schedule, and handler are required.');
      return;
    }
    setSaving(true);
    setErr(null);
    try {
      await onSave(form);
    } catch (ex: unknown) {
      setErr(ex instanceof Error ? ex.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  }

  const inputStyle: React.CSSProperties = {
    padding: '7px 10px', fontSize: '13px', color: '#f9fafb',
    backgroundColor: '#0a0e1a', border: '1px solid #1f2937',
    borderRadius: '6px', outline: 'none', fontFamily: 'Inter, system-ui, sans-serif', width: '100%',
  };
  const labelStyle: React.CSSProperties = {
    display: 'flex', flexDirection: 'column', gap: '5px',
    fontSize: '12px', color: '#9ca3af',
  };

  return (
    <form
      onSubmit={handleSubmit}
      aria-label={editingId ? 'Edit cron job' : 'Create cron job'}
      style={{
        backgroundColor: '#111827', border: '1px solid #1f2937',
        borderRadius: '10px', padding: '20px', marginTop: '16px',
        display: 'flex', flexDirection: 'column', gap: '14px',
      }}
    >
      <h2 style={{ margin: 0, fontSize: '14px', fontWeight: 700, color: '#f9fafb' }}>
        {editingId ? 'Edit Job' : 'Create Job'}
      </h2>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: '12px' }}>
        <label style={labelStyle}>
          Name
          <input style={inputStyle} value={form.name} onChange={e => set('name', e.target.value)}
            placeholder="Job name" aria-required="true"
            onFocus={e => { e.currentTarget.style.borderColor = '#3b82f6'; }}
            onBlur={e => { e.currentTarget.style.borderColor = '#1f2937'; }}
          />
        </label>

        <label style={labelStyle}>
          Schedule type
          <select
            value={form.scheduleType}
            onChange={e => set('scheduleType', e.target.value as ScheduleType)}
            aria-label="Schedule type"
            style={{ ...inputStyle, cursor: 'pointer' }}
          >
            <option value="cron">Cron expression</option>
            <option value="interval">Every X minutes</option>
            <option value="time">At specific time</option>
          </select>
        </label>

        <label style={labelStyle}>
          {form.scheduleType === 'cron' ? 'Expression' : form.scheduleType === 'interval' ? 'Minutes' : 'Time (HH:MM)'}
          <input style={inputStyle}
            value={form.scheduleValue}
            onChange={e => set('scheduleValue', e.target.value)}
            placeholder={form.scheduleType === 'cron' ? '0 */6 * * *' : form.scheduleType === 'interval' ? '30' : '08:00'}
            aria-required="true"
            onFocus={e => { e.currentTarget.style.borderColor = '#3b82f6'; }}
            onBlur={e => { e.currentTarget.style.borderColor = '#1f2937'; }}
          />
        </label>

        <label style={labelStyle}>
          Handler / command
          <input style={inputStyle}
            value={form.handler}
            onChange={e => set('handler', e.target.value)}
            placeholder="e.g. tasks.syncData"
            aria-required="true"
            onFocus={e => { e.currentTarget.style.borderColor = '#3b82f6'; }}
            onBlur={e => { e.currentTarget.style.borderColor = '#1f2937'; }}
          />
        </label>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: '16px', flexWrap: 'wrap' }}>
        <Toggle label="Enabled" checked={form.enabled} onChange={v => set('enabled', v)} />
        {err && <span role="alert" style={{ fontSize: '12px', color: '#ef4444' }}>{err}</span>}
        <div style={{ marginLeft: 'auto', display: 'flex', gap: '8px' }}>
          <button type="button" onClick={onCancel}
            style={{ padding: '7px 14px', fontSize: '12px', fontWeight: 600, backgroundColor: '#1f2937', color: '#f9fafb', border: 'none', borderRadius: '6px', cursor: 'pointer' }}>
            Cancel
          </button>
          <button type="submit" disabled={saving}
            style={{ padding: '7px 14px', fontSize: '12px', fontWeight: 600, backgroundColor: '#3b82f6', color: '#fff', border: 'none', borderRadius: '6px', cursor: saving ? 'not-allowed' : 'pointer', opacity: saving ? 0.7 : 1 }}>
            {saving ? 'Saving…' : editingId ? 'Update' : 'Create'}
          </button>
        </div>
      </div>
    </form>
  );
}

// ─── CronPage ─────────────────────────────────────────────────────────────────

export function CronPage() {
  const [jobs, setJobs] = useState<CronJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [formOpen, setFormOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [formInitial, setFormInitial] = useState<FormState>(emptyForm());
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [runningId, setRunningId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try { setJobs((await api.fetchCronJobs()) as CronJob[]); }
    catch (e: unknown) { setError(e instanceof Error ? e.message : 'Failed to load jobs'); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const filtered = jobs.filter(j => j.name.toLowerCase().includes(search.toLowerCase()));

  async function handleSave(form: FormState) {
    const schedule = buildSchedule(form.scheduleType, form.scheduleValue);
    const payload = { name: form.name, schedule, handler: form.handler, enabled: form.enabled };
    if (editingId) {
      await api.updateCronJob(editingId, payload);
      setJobs(js => js.map(j => j.id === editingId ? { ...j, ...payload } : j));
    } else {
      const res = await api.createCronJob(payload) as { job: CronJob };
      setJobs(js => [...js, res.job]);
    }
    setFormOpen(false); setEditingId(null); setFormInitial(emptyForm());
  }

  async function handleToggle(id: string, enabled: boolean) {
    await api.toggleCronJob(id, enabled);
    setJobs(js => js.map(j => j.id === id ? { ...j, enabled } : j));
  }

  async function handleDelete() {
    if (!deleteTarget) return;
    await api.deleteCronJob(deleteTarget);
    setJobs(js => js.filter(j => j.id !== deleteTarget));
    setDeleteTarget(null);
  }

  async function handleRun(id: string) {
    setRunningId(id);
    try { await api.runCronJob(id); await load(); }
    finally { setRunningId(null); }
  }

  const columns = [
    { key: 'name', header: 'Name', sortable: true, width: '22%' },
    { key: 'schedule', header: 'Schedule', width: '16%' },
    {
      key: 'enabled', header: 'Status', width: '10%',
      render: (row: CronJob) => (
        <StatusDot status={row.enabled ? 'online' : 'offline'} label={row.enabled ? 'Enabled' : 'Disabled'} />
      ),
    },
    { key: 'lastRun', header: 'Last Run', width: '18%', render: (r: CronJob) => <span style={{ color: '#9ca3af', fontSize: '12px' }}>{formatDate(r.lastRun)}</span> },
    {
      key: 'consecutiveErrors', header: 'Errors', width: '8%',
      render: (r: CronJob) => (
        <span style={{ color: r.consecutiveErrors > 0 ? '#ef4444' : '#9ca3af', fontWeight: r.consecutiveErrors > 0 ? 700 : 400 }}>
          {r.consecutiveErrors}
        </span>
      ),
    },
    {
      key: 'actions', header: 'Actions', width: '26%',
      render: (r: CronJob) => (
        <div style={{ display: 'flex', gap: '6px' }}>
          <Toggle label="" checked={r.enabled} onChange={en => handleToggle(r.id, en)} />
          <button onClick={() => handleRun(r.id)} disabled={runningId === r.id}
            aria-label={`Run ${r.name} now`}
            style={actionBtn('#1d4ed8')}>
            {runningId === r.id ? <Spinner size="sm" /> : 'Run'}
          </button>
          <button onClick={() => setDeleteTarget(r.id)} aria-label={`Delete ${r.name}`}
            style={actionBtn('#7f1d1d', '#b91c1c')}>
            Del
          </button>
        </div>
      ),
    },
  ];

  function actionBtn(bg: string, hover?: string): React.CSSProperties {
    return { padding: '3px 8px', fontSize: '11px', fontWeight: 600, backgroundColor: bg, color: '#fff', border: 'none', borderRadius: '4px', cursor: 'pointer' };
  }

  if (loading) return <div style={{ display: 'flex', justifyContent: 'center', paddingTop: '60px' }}><Spinner size="lg" /></div>;
  if (error) return <div style={{ padding: '24px', color: '#ef4444', fontSize: '14px' }}>{error} — <button onClick={load} style={{ color: '#3b82f6', background: 'none', border: 'none', cursor: 'pointer', textDecoration: 'underline' }}>Retry</button></div>;

  return (
    <main style={{ padding: '24px', fontFamily: 'Inter, system-ui, sans-serif' }}>
      <header style={{ marginBottom: '20px' }}>
        <h1 style={{ margin: 0, fontSize: '20px', fontWeight: 700, color: '#f9fafb' }}>Cron Jobs</h1>
        <p style={{ margin: '4px 0 0', fontSize: '13px', color: '#9ca3af' }}>{jobs.length} job{jobs.length !== 1 ? 's' : ''} scheduled</p>
      </header>

      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '16px', flexWrap: 'wrap' }}>
        <div style={{ flex: '1 1 220px', maxWidth: '360px' }}>
          <SearchInput value={search} onChange={setSearch} placeholder="Search jobs…" />
        </div>
        <button
          onClick={() => { setEditingId(null); setFormInitial(emptyForm()); setFormOpen(o => !o); }}
          aria-expanded={formOpen}
          style={{ padding: '8px 16px', fontSize: '13px', fontWeight: 600, backgroundColor: '#3b82f6', color: '#fff', border: 'none', borderRadius: '8px', cursor: 'pointer', whiteSpace: 'nowrap' }}
        >
          {formOpen && !editingId ? 'Cancel' : '+ Create Job'}
        </button>
      </div>

      <DataTable
        columns={columns as Parameters<typeof DataTable>[0]['columns']}
        data={filtered as unknown as Record<string, unknown>[]}
        keyField="id"
        emptyMessage="No cron jobs found."
      />

      {formOpen && (
        <JobForm
          initial={formInitial}
          editingId={editingId}
          onSave={handleSave}
          onCancel={() => { setFormOpen(false); setEditingId(null); setFormInitial(emptyForm()); }}
        />
      )}

      <ConfirmDialog
        open={deleteTarget !== null}
        title="Delete Job"
        message="This cron job will be permanently removed. This action cannot be undone."
        confirmLabel="Delete"
        danger
        onConfirm={handleDelete}
        onCancel={() => setDeleteTarget(null)}
      />
    </main>
  );
}
