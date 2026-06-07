import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { createLogger } from '../shared/logger.js';
import { genId } from '../shared/utils.js';

const log = createLogger('agent:coordinator');

export type OperationRisk = 'low' | 'medium' | 'high' | 'critical';

export interface CoordinatorRequest {
  id: string;
  timestamp: string;
  workerId: string;
  operation: string;
  risk: OperationRisk;
  toolName: string;
  toolInput: unknown;
  status: 'pending' | 'approved' | 'rejected' | 'claimed';
  claimedBy?: string;
  resolution?: string;
  resolvedAt?: string;
}

export class Coordinator {
  private requests: CoordinatorRequest[] = [];

  constructor(private mailboxPath = 'data/coordinator-mailbox.json') {
    const dir = mailboxPath.split('/').slice(0, -1).join('/');
    if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });
    this.load();
  }

  async submit(workerId: string, operation: string, risk: OperationRisk, toolName: string, toolInput: unknown): Promise<string> {
    const req: CoordinatorRequest = {
      id: genId(),
      timestamp: new Date().toISOString(),
      workerId, operation, risk, toolName, toolInput,
      status: 'pending',
    };
    this.requests.push(req);
    this.save();
    log.info({ id: req.id, risk, toolName }, 'Coordinator request submitted');
    return req.id;
  }

  claim(requestId: string, coordinatorId: string): boolean {
    const req = this.requests.find(r => r.id === requestId && r.status === 'pending');
    if (!req) return false;
    req.status = 'claimed';
    req.claimedBy = coordinatorId;
    this.save();
    return true;
  }

  resolve(requestId: string, approved: boolean, reason: string): boolean {
    const req = this.requests.find(r => r.id === requestId && r.status === 'claimed');
    if (!req) return false;
    req.status = approved ? 'approved' : 'rejected';
    req.resolution = reason;
    req.resolvedAt = new Date().toISOString();
    this.save();
    return true;
  }

  async waitForResolution(requestId: string, timeoutMs = 30000): Promise<'approved' | 'rejected' | 'timeout'> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      this.load();
      const req = this.requests.find(r => r.id === requestId);
      if (req?.status === 'approved') return 'approved';
      if (req?.status === 'rejected') return 'rejected';
      await new Promise(r => setTimeout(r, 3000));
    }
    return 'timeout';
  }

  getPending(): CoordinatorRequest[] {
    return this.requests.filter(r => r.status === 'pending');
  }

  getForWorker(workerId: string): CoordinatorRequest[] {
    return this.requests.filter(r => r.workerId === workerId);
  }

  static needsApproval(toolName: string, toolInput: unknown): { needs: boolean; risk: OperationRisk } {
    const input = JSON.stringify(toolInput ?? '').toLowerCase();
    const name = toolName.toLowerCase();

    // Critical: destructive irreversible operations
    if (input.includes('rm -rf') || input.includes('drop table') || input.includes('git reset --hard') || name.includes('destroy')) {
      return { needs: true, risk: 'critical' };
    }
    // High: state-modifying external operations
    if (name.includes('delete') || input.includes('git push') || name.includes('service-control') || input.includes('systemctl stop')) {
      return { needs: true, risk: 'high' };
    }
    // Medium: writes that can be undone
    if (name.includes('write') || name.includes('self-config') || input.includes('npm install')) {
      return { needs: true, risk: 'medium' };
    }
    return { needs: false, risk: 'low' };
  }

  private load(): void {
    if (!existsSync(this.mailboxPath)) {
      this.requests = [];
      return;
    }
    try {
      this.requests = JSON.parse(readFileSync(this.mailboxPath, 'utf8')) as CoordinatorRequest[];
    } catch (e) {
      // Transient read/parse failures (e.g. a concurrent non-atomic write
      // producing a partial file) must not wipe valid in-memory state.
      log.warn({ err: String(e) }, 'Coordinator load failed; keeping existing in-memory requests');
    }
  }

  private save(): void {
    try {
      const tmpPath = `${this.mailboxPath}.${process.pid}.tmp`;
      writeFileSync(tmpPath, JSON.stringify(this.requests, null, 2));
      renameSync(tmpPath, this.mailboxPath);
    } catch (e) { log.error({ err: String(e) }, 'Coordinator save failed'); }
  }
}
