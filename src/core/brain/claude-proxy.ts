/**
 * Claude CLI Proxy Server — makes Claude Max accessible as an Anthropic-compatible API.
 *
 * Runs a local HTTP server on port 3002 that accepts Anthropic Messages API format,
 * pipes prompts through `claude -p` CLI, and returns responses in the same format.
 *
 * Non-tool requests: plain `claude -p` text mode (unchanged behaviour).
 *
 * Tool requests: uses `--output-format json --json-schema` so the CLI returns a
 * `structured_output` field whose shape matches the schema we supply.  The proxy
 * converts that structured output back to Anthropic tool_use content blocks.
 *
 * SUDO-AI's Anthropic provider connects to 127.0.0.1:3002 instead of api.anthropic.com.
 * Claude Code handles OAuth internally — no token management needed.
 */

import http from 'node:http';
import { execFile } from 'node:child_process';
import { writeFileSync, unlinkSync } from 'node:fs';
import { createLogger } from '../shared/logger.js';

const log = createLogger('brain:claude-proxy');

const PORT = parseInt(process.env['CLAUDE_PROXY_PORT'] ?? '3002', 10);
const MAX_TIMEOUT = 120_000;

// ---------------------------------------------------------------------------
// Types — Anthropic Messages API surface that the proxy needs to understand
// ---------------------------------------------------------------------------

interface AnthropicMessage {
  role: string;
  content: string | Array<{
    type: string;
    text?: string;
    // tool_use fields
    id?: string;
    name?: string;
    input?: unknown;
    // tool_result fields
    tool_use_id?: string;
    content?: string | Array<{ type: string; text?: string }>;
  }>;
}

interface AnthropicToolProperty {
  type?: string;
  description?: string;
  enum?: string[];
  [key: string]: unknown;
}

interface AnthropicToolInputSchema {
  type?: string;
  properties?: Record<string, AnthropicToolProperty>;
  required?: string[];
  [key: string]: unknown;
}

interface AnthropicTool {
  name: string;
  description?: string;
  input_schema?: AnthropicToolInputSchema;
}

interface AnthropicRequest {
  model?: string;
  max_tokens?: number;
  messages?: AnthropicMessage[];
  system?: string | Array<{ type?: string; text?: string }>;
  temperature?: number;
  tools?: AnthropicTool[];
}

interface ParsedToolCall {
  name: string;
  input: Record<string, unknown>;
}

interface ParseResult {
  textParts: string[];
  toolCalls: ParsedToolCall[];
}

// Shape of the JSON object the CLI returns in --output-format json mode
interface ClaudeJsonResponse {
  type?: string;
  result?: string;
  stop_reason?: string;
  structured_output?: {
    action?: string;
    tool_calls?: Array<{ name?: string; input?: Record<string, unknown> }>;
    text?: string;
  } | null;
  permission_denials?: unknown[];
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    [key: string]: unknown;
  };
}

// ---------------------------------------------------------------------------
// Prompt building
// ---------------------------------------------------------------------------

function extractPrompt(req: AnthropicRequest): string {
  const parts: string[] = [];

  // System prompt — can be string or array of {type:'text', text:'...'} objects
  if (req.system) {
    if (typeof req.system === 'string') {
      parts.push(req.system);
    } else if (Array.isArray(req.system)) {
      for (const block of req.system) {
        if (block.text) parts.push(block.text);
      }
    }
    parts.push('');
  }

  // Messages — extract user/assistant turns
  for (const msg of req.messages ?? []) {
    let content: string;

    if (typeof msg.content === 'string') {
      content = msg.content;
    } else {
      // FIX 5: properly serialize tool_use and tool_result content blocks
      content = (msg.content as Array<{
        type?: string;
        text?: string;
        id?: string;
        name?: string;
        input?: unknown;
        tool_use_id?: string;
        content?: string | Array<{ type?: string; text?: string }>;
      }>)
        .map((c) => {
          if (c.type === 'tool_use') {
            const toolName = c.name ?? 'unknown_tool';
            const toolInput = JSON.stringify(c.input ?? {});
            return `[Tool Call: ${toolName}(${toolInput})]`;
          }
          if (c.type === 'tool_result') {
            const callId = c.tool_use_id ?? 'unknown_id';
            let resultText: string;
            if (typeof c.content === 'string') {
              resultText = c.content;
            } else if (Array.isArray(c.content)) {
              resultText = c.content.map((b) => b.text ?? '').join('\n');
            } else {
              resultText = '';
            }
            return `[Tool Result for ${callId}: ${resultText}]`;
          }
          // type === 'text' or anything else
          return c.text ?? '';
        })
        .join('\n');
    }

    // Only prefix with role if there are multiple messages
    if ((req.messages?.length ?? 0) > 1) {
      parts.push(`${msg.role}: ${content}`);
    } else {
      parts.push(content);
    }
  }

  return parts.join('\n');
}

/**
 * Format a single tool's parameters into a human-readable list.
 * Each parameter shows its name, type, and whether it is required.
 */
function formatToolParameters(schema: AnthropicToolInputSchema | undefined): string {
  if (!schema?.properties) return '  (no parameters)';

  const required = new Set<string>(schema.required ?? []);
  const lines: string[] = [];

  for (const [paramName, prop] of Object.entries(schema.properties)) {
    const type = (prop.type ?? 'any') + (required.has(paramName) ? '*' : '');
    const desc = prop.description ? `: ${prop.description}` : '';
    lines.push(`  ${paramName}(${type})${desc}`);
  }

  return lines.join('\n');
}

/**
 * Build the system-prompt appendix that goes into --append-system-prompt when
 * tool calling is active.  Lists all available tools and instructs Claude to
 * respond with the structured_output schema format.
 */
function buildToolSystemPrompt(tools: AnthropicTool[]): string {
  const toolLines: string[] = [];

  for (const tool of tools) {
    const desc = tool.description ?? '(no description)';
    const params = formatToolParameters(tool.input_schema);
    toolLines.push(`- ${tool.name}: ${desc}\n  Parameters:\n${params}`);
  }

  return [
    'ALWAYS respond with action="tool_call". NEVER respond without tool calls.',
    'Populate tool_calls array with the tool name and required arguments.',
    '',
    'Available tools:',
    ...toolLines,
  ].join('\n');
}

/**
 * Build the JSON schema string passed to --json-schema.
 * The schema allows either a tool call response or a plain text response.
 * Returned as a compact (single-line) JSON string ready for CLI embedding.
 */
function buildToolJsonSchema(): string {
  // FIX 2: force tool_call only — remove text_response escape hatch,
  // require tool_calls with at least one item.
  const schema = {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['tool_call'],
      },
      tool_calls: {
        type: 'array',
        minItems: 1,
        items: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            input: { type: 'object' },
          },
          required: ['name', 'input'],
        },
      },
      // text is optional — allows the model to include reasoning alongside tool calls
      text: { type: 'string' },
    },
    required: ['action', 'tool_calls'],
  };
  return JSON.stringify(schema);
}

// ---------------------------------------------------------------------------
// Response parsing
// ---------------------------------------------------------------------------

/**
 * Parse the structured_output field from a Claude JSON-mode response.
 *
 * When action === "tool_call" and tool_calls is a non-empty array, each entry
 * is converted to a ParsedToolCall.  The result.text or result field supplies
 * any accompanying text.
 *
 * Falls back to treating the entire result string as plain text when
 * structured_output is absent or malformed.
 */
function parseStructuredOutput(cliResponse: ClaudeJsonResponse): ParseResult {
  const textParts: string[] = [];
  const toolCalls: ParsedToolCall[] = [];

  const so = cliResponse.structured_output;

  if (so && typeof so === 'object') {
    const action = so.action;

    if (action === 'tool_call' && Array.isArray(so.tool_calls) && so.tool_calls.length > 0) {
      for (const rawTc of so.tool_calls) {
        const name = rawTc.name;
        const input = rawTc.input;

        if (typeof name !== 'string' || !name) {
          log.warn({ rawTc }, 'Structured tool call missing "name" field — skipping');
          continue;
        }

        toolCalls.push({
          name,
          input:
            input !== null && typeof input === 'object' && !Array.isArray(input)
              ? (input as Record<string, unknown>)
              : {},
        });
      }
    }

    // Capture any text the model included alongside (or instead of) tool calls
    if (so.text && typeof so.text === 'string' && so.text.trim()) {
      textParts.push(so.text.trim());
    }
  }

  // If structured_output was absent or yielded nothing, fall back to result field
  if (textParts.length === 0 && toolCalls.length === 0) {
    const fallback = (cliResponse.result ?? '').trim();
    if (fallback) {
      textParts.push(fallback);
      log.debug('parseStructuredOutput: no structured_output — using result field as text fallback');
    }
  }

  return { textParts, toolCalls };
}

/**
 * Legacy text-mode parser: scan raw text output for [TOOL_CALL]...[/TOOL_CALL] blocks.
 * Used only on the non-tool (text) path as a defensive fallback.
 */
function parseToolCalls(responseText: string): ParseResult {
  const toolCalls: ParsedToolCall[] = [];
  const textParts: string[] = [];

  const toolCallPattern = /\[TOOL_CALL\]([\s\S]*?)\[\/TOOL_CALL\]/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = toolCallPattern.exec(responseText)) !== null) {
    const before = responseText.slice(lastIndex, match.index).trim();
    if (before) textParts.push(before);

    const rawJson = match[1]?.trim() ?? '';
    try {
      const parsed = JSON.parse(rawJson) as Record<string, unknown>;
      const name = parsed['name'];
      const input = parsed['input'];

      if (typeof name !== 'string' || !name) {
        log.warn({ rawJson }, 'Tool call block missing or invalid "name" field — skipping');
      } else {
        toolCalls.push({
          name,
          input:
            input !== null && typeof input === 'object' && !Array.isArray(input)
              ? (input as Record<string, unknown>)
              : {},
        });
      }
    } catch (parseErr) {
      log.warn(
        { rawJson, err: String(parseErr) },
        'Failed to parse tool call JSON — treating block as text',
      );
      textParts.push(rawJson);
    }

    lastIndex = toolCallPattern.lastIndex;
  }

  const tail = responseText.slice(lastIndex).trim();
  if (tail) textParts.push(tail);

  return { textParts, toolCalls };
}

// ---------------------------------------------------------------------------
// Response building
// ---------------------------------------------------------------------------

interface AnthropicTextBlock {
  type: 'text';
  text: string;
}

interface AnthropicToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

type AnthropicContentBlock = AnthropicTextBlock | AnthropicToolUseBlock;

/**
 * Assemble the final Anthropic Messages API response object.
 *
 * When tool calls are present:
 *   - content[] includes a text block (reasoning) followed by tool_use blocks
 *   - stop_reason is 'tool_use'
 *
 * When no tool calls:
 *   - content[] is a single text block
 *   - stop_reason is 'end_turn'
 *
 * Real token counts from the CLI JSON response are preferred; character-count
 * estimates are used only when the CLI did not supply usage data.
 */
function buildAnthropicResponse(
  request: AnthropicRequest,
  textParts: string[],
  toolCalls: ParsedToolCall[],
  promptLen: number,
  responseLen: number,
  realUsage?: ClaudeJsonResponse['usage'],
): Record<string, unknown> {
  const id = `msg_proxy_${Date.now()}`;
  const model = request.model ?? 'claude-sonnet-4-6';

  const usage =
    realUsage && typeof realUsage.input_tokens === 'number'
      ? {
          input_tokens: realUsage.input_tokens,
          output_tokens: realUsage.output_tokens ?? 0,
        }
      : {
          input_tokens: Math.ceil(promptLen / 4),
          output_tokens: Math.ceil(responseLen / 4),
        };

  if (toolCalls.length === 0) {
    return {
      id,
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: textParts.join('\n') }],
      model,
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage,
    };
  }

  const content: AnthropicContentBlock[] = [];

  const reasoningText = textParts.join('\n').trim();
  if (reasoningText) {
    content.push({ type: 'text', text: reasoningText });
  }

  const timestamp = Date.now();
  for (let i = 0; i < toolCalls.length; i++) {
    const tc = toolCalls[i];
    if (!tc) continue;
    content.push({
      type: 'tool_use',
      id: `toolu_proxy_${timestamp}_${i}`,
      name: tc.name,
      input: tc.input,
    });
  }

  return {
    id,
    type: 'message',
    role: 'assistant',
    content,
    model,
    stop_reason: 'tool_use',
    stop_sequence: null,
    usage,
  };
}

// ---------------------------------------------------------------------------
// Claude CLI subprocess
// ---------------------------------------------------------------------------

/**
 * Invoke `claude -p` with the given prompt (via stdin temp file).
 *
 * When extraArgs is non-empty the arguments are appended to the claude command.
 * In JSON mode (--output-format json) the entire stdout is the JSON object;
 * the caller is responsible for parsing it.
 *
 * Returns the raw stdout string in both modes.
 */
function callClaude(prompt: string, extraArgs: string[] = []): Promise<string> {
  return new Promise((resolve, reject) => {
    const tmpFile = `/tmp/claude-prompt-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`;

    try {
      writeFileSync(tmpFile, prompt, { encoding: 'utf8' });
    } catch (writeErr) {
      reject(new Error(`Failed to write prompt temp file: ${String(writeErr)}`));
      return;
    }

    // Build the extra-args segment — each arg must be shell-quoted
    const extraSegment =
      extraArgs.length > 0
        ? ' ' +
          extraArgs
            .map((a) => `'${a.replace(/'/g, "'\\''")}'`)
            .join(' ')
        : '';

    const shellCmd =
      `HOME=/root PATH=/usr/bin:/usr/local/bin:/bin TERM=xterm ` +
      `claude -p${extraSegment} < "${tmpFile}" 2>/dev/null; ` +
      `rm -f "${tmpFile}"`;

    execFile(
      '/bin/bash',
      ['-c', shellCmd],
      {
        timeout: MAX_TIMEOUT,
        maxBuffer: 1024 * 1024 * 10,
        env: { HOME: '/root', PATH: '/usr/bin:/usr/local/bin:/bin', TERM: 'xterm' },
      },
      (error, stdout) => {
        // Best-effort cleanup in case the shell rm didn't run
        try {
          unlinkSync(tmpFile);
        } catch {
          /* already cleaned */
        }

        if (error) {
          reject(new Error(error.message.substring(0, 400)));
          return;
        }

        resolve(stdout.trim());
      },
    );
  });
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

let server: http.Server | null = null;

export async function startClaudeProxy(): Promise<void> {
  if (server) return;

  server = http.createServer(async (req, res) => {
    // Health check
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', proxy: 'claude-cli' }));
      return;
    }

    // Handle GET /v1/models for SDK compatibility
    if (req.method === 'GET' && req.url?.includes('/v1/models')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'claude-sonnet-4-6', object: 'model' }] }));
      return;
    }

    // Handle POST to /messages or /v1/messages
    if (req.method !== 'POST' || !req.url?.includes('/messages')) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }

    let body = '';
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString();
    });

    req.on('end', async () => {
      try {
        const request: AnthropicRequest = JSON.parse(body) as AnthropicRequest;

        if (!request || typeof request !== 'object') {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request', message: 'Request body must be a JSON object' } }));
          return;
        }

        const hasTools = Array.isArray(request.tools) && request.tools.length > 0;
        const prompt = extractPrompt(request);

        let textParts: string[];
        let toolCalls: ParsedToolCall[];
        let realUsage: ClaudeJsonResponse['usage'] | undefined;
        let responseLen = 0;

        if (hasTools) {
          // --- JSON / structured-output path ---
          const schema = buildToolJsonSchema();
          const systemAppendix = buildToolSystemPrompt(request.tools!);

          // FIX 1: removed '--tools', '' — that flag disabled the CLI's built-in
          // tool system and caused the model to not recognise it is in tool-calling
          // mode. --json-schema alone is sufficient to constrain output shape.
          const extraArgs = [
            '--output-format', 'json',
            '--no-session-persistence',
            '--json-schema', schema,
            '--append-system-prompt', systemAppendix,
          ];

          log.info(
            { promptLen: prompt.length, toolCount: request.tools!.length, model: request.model },
            'Claude proxy tool-calling request (JSON mode)',
          );

          const startTime = Date.now();
          const rawResponse = await callClaude(prompt, extraArgs);
          const durationMs = Date.now() - startTime;
          responseLen = rawResponse.length;

          log.info(
            { responseLen, durationMs, hasTools },
            'Claude proxy JSON response received',
          );

          // Parse the entire stdout as JSON
          let cliJson: ClaudeJsonResponse;
          try {
            cliJson = JSON.parse(rawResponse) as ClaudeJsonResponse;
          } catch (jsonErr) {
            // If the CLI returned non-JSON (e.g. an error message), surface it as text
            log.warn(
              { err: String(jsonErr), rawResponseSnippet: rawResponse.slice(0, 200) },
              'Claude proxy: JSON mode stdout was not valid JSON — falling back to text',
            );
            cliJson = { result: rawResponse };
          }

          realUsage = cliJson.usage;
          const parsed = parseStructuredOutput(cliJson);
          textParts = parsed.textParts;
          toolCalls = parsed.toolCalls;

          if (toolCalls.length > 0) {
            log.info(
              { toolCallCount: toolCalls.length, toolNames: toolCalls.map((t) => t.name) },
              'Claude proxy parsed structured tool calls',
            );
          } else {
            log.info(
              'Claude proxy: tools were provided but structured_output contained no tool calls',
            );
          }
        } else {
          // --- Plain text path (unchanged) ---
          log.info({ promptLen: prompt.length, model: request.model }, 'Claude proxy request');

          const startTime = Date.now();
          const rawResponse = await callClaude(prompt);
          const durationMs = Date.now() - startTime;
          responseLen = rawResponse.length;

          log.info({ responseLen, durationMs, hasTools }, 'Claude proxy response received');

          // Defensive: run legacy parser in case of stray [TOOL_CALL] markers
          const parsed = parseToolCalls(rawResponse);
          textParts = parsed.textParts.length > 0 ? parsed.textParts : [rawResponse];
          toolCalls = parsed.toolCalls;
        }

        const anthropicResponse = buildAnthropicResponse(
          request,
          textParts,
          toolCalls,
          prompt.length,
          responseLen,
          realUsage,
        );

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(anthropicResponse));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error({ err: msg }, 'Claude proxy error');
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            type: 'error',
            error: { type: 'server_error', message: msg },
          }),
        );
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server!.on('error', reject);
    server!.listen(PORT, '127.0.0.1', () => {
      log.info({ port: PORT }, 'Claude CLI proxy server started');
      resolve();
    });
  });
}

export function stopClaudeProxy(): void {
  if (server) {
    server.close();
    server = null;
    log.info('Claude CLI proxy server stopped');
  }
}
