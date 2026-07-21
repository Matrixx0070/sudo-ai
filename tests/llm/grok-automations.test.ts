/**
 * @file grok-automations.test.ts
 * @description Unit tests for the subscription-free Grok automations/tasks
 * lanes (list/catalog/tasks/tools + one-time create/delete). NO net/browser/
 * disk: the manager + bridge are injected. Mocks mirror the REAL response
 * shapes probed live 2026-07-21 (GET /rest/automations → {automations};
 * catalog → {groups}; /rest/tasks → {tasks,taskUsage}; /rest/task/tools →
 * {tools}; POST create → Automation with taskId + server-forced
 * isEnabled:true; DELETE → {deleted:true}). The live grok.com round-trip is
 * proven separately (never in CI).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

beforeEach(() => {
  process.env['SUDO_GROK_WEBSESSION'] = '1';
});
afterEach(() => {
  delete process.env['SUDO_GROK_WEBSESSION'];
  vi.resetModules();
});

const SESSION = { cookie: 'cf_clearance=X; sso=Y', userAgent: 'UA' };
function fakeManager(session = SESSION) {
  return {
    ensureHealthy: async () => session,
  } as unknown as import('../../src/llm/grok-web-session-manager.js').GrokWebSessionManager;
}

// Mirrors the exact live POST /rest/automations echo (2026-07-21), including
// the server forcing isEnabled:true despite a disabled-create request.
const LIVE_AUTOMATION = {
  taskId: '185590e3-b0d9-46cf-9164-6cc9837137d6',
  content: {
    name: 'probe',
    prompt: 'Do nothing.',
    metadataJsonString: '{}',
    notificationMethod: 'DEFAULT',
    fileAttachments: [],
    connectors: [],
  },
  isActive: true,
  schedules: [
    {
      scheduleId: 'b6fa6a48-9bf3-44aa-ad7d-be1df5f01a46',
      taskCadence: 'TASK_CADENCE_ONCE',
      isEnabled: true,
      nextRun: '2027-05-01T00:00:00Z',
      dayOfYear: '2027-05-01',
      timeOfDay: '00:00',
      timezone: 'UTC',
      isCompleted: false,
      endDate: null,
    },
  ],
  triggers: [],
};

describe('listGrokAutomations', () => {
  it('sends a list op with cookie creds and parses automations', async () => {
    const { listGrokAutomations } = await import('../../src/llm/grok-automations.js');
    const bridge = vi.fn(async (req: { op: string }, creds: { cookie: string; userAgent: string }) => {
      expect(req.op).toBe('list');
      expect(creds.cookie).toBe(SESSION.cookie);
      expect(creds.userAgent).toBe(SESSION.userAgent);
      // Mirrors live GET /rest/automations → {"automations":[...]}.
      return { ok: true, automations: [LIVE_AUTOMATION] };
    });
    const r = await listGrokAutomations({ deps: { manager: fakeManager(), bridge: bridge as never } });
    expect(r).toHaveLength(1);
    expect(r[0]?.taskId).toBe(LIVE_AUTOMATION.taskId);
    expect(bridge).toHaveBeenCalledOnce();
  });

  it('accepts an empty account (live default: {"automations":[]})', async () => {
    const { listGrokAutomations } = await import('../../src/llm/grok-automations.js');
    const bridge = vi.fn(async () => ({ ok: true, automations: [] }));
    const r = await listGrokAutomations({ deps: { manager: fakeManager(), bridge: bridge as never } });
    expect(r).toEqual([]);
  });

  it('flag OFF → GrokWebDisabledError (never calls the bridge)', async () => {
    process.env['SUDO_GROK_WEBSESSION'] = '0';
    const { listGrokAutomations, GrokWebDisabledError } = await import('../../src/llm/grok-automations.js');
    let called = false;
    await expect(
      listGrokAutomations({
        deps: {
          manager: fakeManager(),
          bridge: (async () => { called = true; return { ok: true, automations: [] }; }) as never,
        },
      }),
    ).rejects.toBeInstanceOf(GrokWebDisabledError);
    expect(called).toBe(false);
  });

  it('bridge ok:false → structured throw', async () => {
    const { listGrokAutomations } = await import('../../src/llm/grok-automations.js');
    const bridge = vi.fn(async () => ({ ok: false, errorClass: 'cloudflare' as const, detail: 'Just a moment' }));
    await expect(
      listGrokAutomations({ deps: { manager: fakeManager(), bridge: bridge as never } }),
    ).rejects.toThrow(/Grok automations list failed: cloudflare/);
  });

  it('ok reply without automations array → structured error (no silent empty)', async () => {
    const { listGrokAutomations } = await import('../../src/llm/grok-automations.js');
    const bridge = vi.fn(async () => ({ ok: true }));
    await expect(
      listGrokAutomations({ deps: { manager: fakeManager(), bridge: bridge as never } }),
    ).rejects.toThrow(/Grok automations list failed/);
  });
});

describe('getGrokAutomationCatalog', () => {
  it('sends catalog and parses provider groups (live shape)', async () => {
    const { getGrokAutomationCatalog } = await import('../../src/llm/grok-automations.js');
    const bridge = vi.fn(async (req: { op: string }) => {
      expect(req.op).toBe('catalog');
      // Mirrors live GET /rest/automations/catalog.
      return {
        ok: true,
        groups: [
          {
            provider: 'gmail',
            displayName: 'Gmail',
            providerEnum: 'TRIGGER_PROVIDER_GMAIL',
            triggers: [
              {
                triggerType: 'new_email',
                displayName: 'When new email',
                description: 'Triggers when a new email arrives matching your filters',
                dimensions: [{ key: 'from', valueType: 'EMAIL' }],
                triggerTypeEnum: 'TRIGGER_TYPE_NEW_EMAIL',
              },
            ],
          },
        ],
      };
    });
    const groups = await getGrokAutomationCatalog({ deps: { manager: fakeManager(), bridge: bridge as never } });
    expect(groups[0]?.provider).toBe('gmail');
    expect(groups[0]?.triggers?.[0]?.triggerType).toBe('new_email');
  });

  it('bridge ok:false → structured throw', async () => {
    const { getGrokAutomationCatalog } = await import('../../src/llm/grok-automations.js');
    const bridge = vi.fn(async () => ({ ok: false, errorClass: 'relogin' as const, detail: 'sso dead' }));
    await expect(
      getGrokAutomationCatalog({ deps: { manager: fakeManager(), bridge: bridge as never } }),
    ).rejects.toThrow(/Grok automations catalog failed: relogin/);
  });
});

describe('listGrokTasks', () => {
  it('sends tasks and parses tasks + usage quotas (live shape)', async () => {
    const { listGrokTasks } = await import('../../src/llm/grok-automations.js');
    const bridge = vi.fn(async (req: { op: string }) => {
      expect(req.op).toBe('tasks');
      // Mirrors live GET /rest/tasks.
      return {
        ok: true,
        tasks: [],
        taskUsage: { frequentUsage: 0, frequentLimit: 10, occasionalUsage: 0, occasionalLimit: 30 },
      };
    });
    const r = await listGrokTasks({ deps: { manager: fakeManager(), bridge: bridge as never } });
    expect(r.tasks).toEqual([]);
    expect(r.usage).toEqual({ frequentUsage: 0, frequentLimit: 10, occasionalUsage: 0, occasionalLimit: 30 });
  });

  it('bridge ok:false → structured throw', async () => {
    const { listGrokTasks } = await import('../../src/llm/grok-automations.js');
    const bridge = vi.fn(async () => ({ ok: false, errorClass: 'timeout' as const, detail: 'bridge timed out' }));
    await expect(
      listGrokTasks({ deps: { manager: fakeManager(), bridge: bridge as never } }),
    ).rejects.toThrow(/Grok automations tasks failed: timeout/);
  });
});

describe('getGrokTaskTools', () => {
  it('sends tools and parses the connector tool catalog (live shape)', async () => {
    const { getGrokTaskTools } = await import('../../src/llm/grok-automations.js');
    const bridge = vi.fn(async (req: { op: string }) => {
      expect(req.op).toBe('tools');
      // Mirrors live GET /rest/task/tools.
      return {
        ok: true,
        tools: [
          { id: 'gmail-ro', label: 'Gmail (Read Only)', icon: '', toolIds: [], connectorIds: ['GOOGLE_GMAIL'] },
        ],
      };
    });
    const tools = await getGrokTaskTools({ deps: { manager: fakeManager(), bridge: bridge as never } });
    expect(tools[0]?.id).toBe('gmail-ro');
    expect(tools[0]?.connectorIds).toEqual(['GOOGLE_GMAIL']);
  });

  it('bridge ok:false → structured throw', async () => {
    const { getGrokTaskTools } = await import('../../src/llm/grok-automations.js');
    const bridge = vi.fn(async () => ({ ok: false, errorClass: 'http_error' as const, detail: 'HTTP 500' }));
    await expect(
      getGrokTaskTools({ deps: { manager: fakeManager(), bridge: bridge as never } }),
    ).rejects.toThrow(/Grok automations tools failed: http_error/);
  });
});

describe('createGrokAutomation', () => {
  const VALID = { name: 'n', prompt: 'p', dayOfYear: '2027-05-01' };

  it('empty name/prompt → TypeError (never calls the bridge)', async () => {
    const { createGrokAutomation } = await import('../../src/llm/grok-automations.js');
    let called = false;
    const deps = {
      manager: fakeManager(),
      bridge: (async () => { called = true; return { ok: true }; }) as never,
    };
    await expect(createGrokAutomation({ ...VALID, name: '  ' }, { deps })).rejects.toBeInstanceOf(TypeError);
    await expect(createGrokAutomation({ ...VALID, prompt: '' }, { deps })).rejects.toBeInstanceOf(TypeError);
    expect(called).toBe(false);
  });

  it('bad dayOfYear / timeOfDay → TypeError', async () => {
    const { createGrokAutomation } = await import('../../src/llm/grok-automations.js');
    const deps = { manager: fakeManager(), bridge: (async () => ({ ok: true })) as never };
    await expect(
      createGrokAutomation({ ...VALID, dayOfYear: '01-01' }, { deps }),
    ).rejects.toBeInstanceOf(TypeError);
    await expect(
      createGrokAutomation({ ...VALID, timeOfDay: '9am' }, { deps }),
    ).rejects.toBeInstanceOf(TypeError);
  });

  it('sends create and returns the live automation echo (taskId + forced-enabled schedule)', async () => {
    const { createGrokAutomation } = await import('../../src/llm/grok-automations.js');
    const bridge = vi.fn(async (req: { op: string; name?: string; dayOfYear?: string }) => {
      expect(req.op).toBe('create');
      expect(req.name).toBe('n');
      expect(req.dayOfYear).toBe('2027-05-01');
      // Mirrors the exact live POST echo — server forces isEnabled:true.
      return { ok: true, automation: LIVE_AUTOMATION };
    });
    const a = await createGrokAutomation(VALID, { deps: { manager: fakeManager(), bridge: bridge as never } });
    expect(a.taskId).toBe(LIVE_AUTOMATION.taskId);
    expect(a.schedules?.[0]?.isEnabled).toBe(true);
  });

  it('bridge ok:false (e.g. >1yr rule) → structured throw', async () => {
    const { createGrokAutomation } = await import('../../src/llm/grok-automations.js');
    const bridge = vi.fn(async () => ({
      ok: false,
      errorClass: 'http_error' as const,
      detail: 'HTTP 400: ONCE tasks cannot be scheduled more than 1 year in the future',
    }));
    await expect(
      createGrokAutomation(VALID, { deps: { manager: fakeManager(), bridge: bridge as never } }),
    ).rejects.toThrow(/Grok automations create failed: http_error/);
  });

  it('ok reply without a taskId → structured error (no phantom automation)', async () => {
    const { createGrokAutomation } = await import('../../src/llm/grok-automations.js');
    const bridge = vi.fn(async () => ({ ok: true, automation: {} }));
    await expect(
      createGrokAutomation(VALID, { deps: { manager: fakeManager(), bridge: bridge as never } }),
    ).rejects.toThrow(/Grok automations create failed/);
  });
});

describe('deleteGrokAutomation', () => {
  it('non-UUID taskId → TypeError (never calls the bridge)', async () => {
    const { deleteGrokAutomation } = await import('../../src/llm/grok-automations.js');
    let called = false;
    await expect(
      deleteGrokAutomation('../evil', {
        deps: { manager: fakeManager(), bridge: (async () => { called = true; return { ok: true }; }) as never },
      }),
    ).rejects.toBeInstanceOf(TypeError);
    expect(called).toBe(false);
  });

  it('sends delete and returns the live {deleted:true}', async () => {
    const { deleteGrokAutomation } = await import('../../src/llm/grok-automations.js');
    const bridge = vi.fn(async (req: { op: string; taskId?: string }) => {
      expect(req.op).toBe('delete');
      expect(req.taskId).toBe(LIVE_AUTOMATION.taskId);
      // Mirrors live DELETE /rest/automations/{id} → {"deleted":true}.
      return { ok: true, deleted: true };
    });
    const r = await deleteGrokAutomation(LIVE_AUTOMATION.taskId, {
      deps: { manager: fakeManager(), bridge: bridge as never },
    });
    expect(r.deleted).toBe(true);
  });

  it('bridge ok:false → structured throw', async () => {
    const { deleteGrokAutomation } = await import('../../src/llm/grok-automations.js');
    const bridge = vi.fn(async () => ({ ok: false, errorClass: 'http_error' as const, detail: 'HTTP 404' }));
    await expect(
      deleteGrokAutomation(LIVE_AUTOMATION.taskId, { deps: { manager: fakeManager(), bridge: bridge as never } }),
    ).rejects.toThrow(/Grok automations delete failed: http_error/);
  });
});
