/**
 * system.docker — Docker and docker-compose operations.
 * All invocations use execFile with argument arrays.
 */

import { createLogger } from '../../../shared/logger.js';
import type { ToolDefinition, ToolContext, ToolResult } from '../../types.js';
import { runCmd, handleNotInstalled } from './exec.js';

const logger = createLogger('system.docker');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ContainerInfo {
  id: string;
  names: string;
  image: string;
  status: string;
  ports: string;
  created: string;
}

interface ImageInfo {
  repository: string;
  tag: string;
  id: string;
  created: string;
  size: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseContainerPs(stdout: string): ContainerInfo[] {
  return stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [id, names, image, status, ports, created] = line.split('\t');
      return { id: id ?? '', names: names ?? '', image: image ?? '', status: status ?? '', ports: ports ?? '', created: created ?? '' };
    });
}

function parseImages(stdout: string): ImageInfo[] {
  return stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [repository, tag, id, created, size] = line.split('\t');
      return { repository: repository ?? '', tag: tag ?? '', id: id ?? '', created: created ?? '', size: size ?? '' };
    });
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

async function dockerPs(ctx: ToolContext): Promise<ToolResult> {
  logger.info({ session: ctx.sessionId }, 'Listing docker containers');
  const { stdout } = await runCmd(
    'docker',
    ['ps', '-a', '--format', '{{.ID}}\t{{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}\t{{.CreatedAt}}'],
    { signal: ctx.signal },
  );
  const containers = parseContainerPs(stdout);
  return { success: true, output: `Found ${containers.length} container(s)`, data: { containers } };
}

async function dockerImages(ctx: ToolContext): Promise<ToolResult> {
  logger.info({ session: ctx.sessionId }, 'Listing docker images');
  const { stdout } = await runCmd(
    'docker',
    ['images', '--format', '{{.Repository}}\t{{.Tag}}\t{{.ID}}\t{{.CreatedAt}}\t{{.Size}}'],
    { signal: ctx.signal },
  );
  const images = parseImages(stdout);
  return { success: true, output: `Found ${images.length} image(s)`, data: { images } };
}

async function dockerLogs(container: string, lines: number, ctx: ToolContext): Promise<ToolResult> {
  logger.info({ session: ctx.sessionId, container }, 'Fetching docker logs');
  const { stdout } = await runCmd(
    'docker',
    ['logs', '--tail', String(lines), container],
    { signal: ctx.signal, allowFailure: true },
  );
  const logLines = stdout.split('\n').filter(Boolean);
  return { success: true, output: `Last ${logLines.length} lines from ${container}`, data: { container, lines: logLines } };
}

async function dockerStop(container: string, ctx: ToolContext): Promise<ToolResult> {
  logger.warn({ session: ctx.sessionId, container }, 'Stopping docker container');
  await runCmd('docker', ['stop', container], { signal: ctx.signal });
  return { success: true, output: `Container "${container}" stopped`, data: { container } };
}

async function dockerRm(container: string, ctx: ToolContext): Promise<ToolResult> {
  logger.warn({ session: ctx.sessionId, container }, 'Removing docker container');
  await runCmd('docker', ['rm', '-f', container], { signal: ctx.signal });
  return { success: true, output: `Container "${container}" removed`, data: { container } };
}

async function dockerRun(
  image: string,
  command: string | undefined,
  flags: string[] | undefined,
  ctx: ToolContext,
): Promise<ToolResult> {
  logger.warn({ session: ctx.sessionId, image }, 'Running docker container');
  const args = ['run', '-d', ...(flags ?? []), image, ...(command ? command.split(' ') : [])];
  const { stdout } = await runCmd('docker', args, { signal: ctx.signal });
  return { success: true, output: `Container started: ${stdout}`, data: { containerId: stdout, image } };
}

async function dockerBuild(image: string, flags: string[] | undefined, ctx: ToolContext): Promise<ToolResult> {
  logger.warn({ session: ctx.sessionId, image }, 'Building docker image');
  const args = ['build', '-t', image, ...(flags ?? []), '.'];
  const { stdout } = await runCmd('docker', args, { signal: ctx.signal, cwd: ctx.workingDir });
  return { success: true, output: `Image "${image}" built`, data: { image, output: stdout } };
}

async function dockerExec(container: string, command: string, ctx: ToolContext): Promise<ToolResult> {
  logger.info({ session: ctx.sessionId, container }, 'Exec into docker container');
  const { stdout } = await runCmd('docker', ['exec', container, ...command.split(' ')], { signal: ctx.signal });
  return { success: true, output: stdout, data: { container, command, output: stdout } };
}

async function composeUp(composePath: string, ctx: ToolContext): Promise<ToolResult> {
  logger.warn({ session: ctx.sessionId, composePath }, 'Running docker compose up');
  const { stdout } = await runCmd(
    'docker',
    ['compose', '-f', composePath, 'up', '-d'],
    { signal: ctx.signal },
  );
  return { success: true, output: `Compose started: ${stdout}`, data: { composePath } };
}

async function composeDown(composePath: string, ctx: ToolContext): Promise<ToolResult> {
  logger.warn({ session: ctx.sessionId, composePath }, 'Running docker compose down');
  await runCmd('docker', ['compose', '-f', composePath, 'down'], { signal: ctx.signal });
  return { success: true, output: `Compose stack at "${composePath}" stopped`, data: { composePath } };
}

async function composePs(composePath: string, ctx: ToolContext): Promise<ToolResult> {
  logger.info({ session: ctx.sessionId, composePath }, 'Listing compose services');
  const { stdout } = await runCmd(
    'docker',
    ['compose', '-f', composePath, 'ps', '--format', 'json'],
    { signal: ctx.signal },
  );
  let services: unknown = stdout;
  try { services = JSON.parse(stdout); } catch { /* keep raw */ }
  return { success: true, output: 'Compose services listed', data: { composePath, services } };
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const dockerTool: ToolDefinition = {
  name: 'system.docker',
  description: 'Manage Docker containers and images, and run docker-compose stacks.',
  category: 'system',
  requiresConfirmation: true,
  timeout: 120_000,
  parameters: {
    operation: {
      type: 'string',
      description: 'Operation: ps | images | logs | stop | rm | run | build | exec | compose-up | compose-down | compose-ps',
      required: true,
      enum: ['ps', 'images', 'logs', 'stop', 'rm', 'run', 'build', 'exec', 'compose-up', 'compose-down', 'compose-ps'],
    },
    container: { type: 'string', description: 'Container name or ID' },
    image: { type: 'string', description: 'Image name:tag' },
    command: { type: 'string', description: 'Command string to run inside container (note: split by spaces — commands with quoted args containing spaces are not supported; use flags array for complex args)' },
    composePath: { type: 'string', description: 'Path to docker-compose.yml file' },
    flags: {
      type: 'array',
      description: 'Extra flags to pass to docker command',
      items: { type: 'string', description: 'Flag string' },
    },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const op = params['operation'] as string;
    const container = params['container'] as string | undefined;
    const image = params['image'] as string | undefined;
    const command = params['command'] as string | undefined;
    const composePath = params['composePath'] as string | undefined;
    const flags = Array.isArray(params['flags']) ? (params['flags'] as string[]) : undefined;

    const requireContainer = (op: string): string => {
      if (!container) throw new Error(`${op} requires container`);
      return container;
    };

    try {
      switch (op) {
        case 'ps':          return dockerPs(ctx);
        case 'images':      return dockerImages(ctx);
        case 'logs':        return dockerLogs(requireContainer('logs'), 100, ctx);
        case 'stop':        return dockerStop(requireContainer('stop'), ctx);
        case 'rm':          return dockerRm(requireContainer('rm'), ctx);
        case 'run':         return dockerRun(image ?? '', command, flags, ctx);
        case 'build':       return dockerBuild(image ?? '', flags, ctx);
        case 'exec':        return dockerExec(requireContainer('exec'), command ?? '', ctx);
        case 'compose-up':  return composeUp(composePath ?? 'docker-compose.yml', ctx);
        case 'compose-down': return composeDown(composePath ?? 'docker-compose.yml', ctx);
        case 'compose-ps':  return composePs(composePath ?? 'docker-compose.yml', ctx);
        default:
          return { success: false, output: `Unknown operation: ${op}`, data: {} };
      }
    } catch (err) {
      if (err instanceof Error && err.message.endsWith('requires container')) {
        return { success: false, output: err.message, data: {} };
      }
      return handleNotInstalled(err, 'docker') as ToolResult;
    }
  },
};
