// 30-05: the replay provider. A loopback HTTP server in the Playwright worker that speaks the
// Anthropic Messages API (non-streaming, the only mode the agent loop and the key validation use).
// fixtures/ai-seam.mjs sends the API's vendor requests here while the address file exists.
//
// It is a deterministic agent, not a recording: each turn it reads the REAL tool results the
// control plane sent back (the `{tool, scope, truncated, data}` envelope) and the active policy
// decides the next tool calls or the final structured answer. Every request body is kept so a
// spec can prove what the "model" saw.
import { unlinkSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { AiStructuredAnswer } from '@noodara/domain/api-contract';

export interface ReplayStep {
  /** The tool_use id: the agent cites it as an evidence ref. */
  readonly id: string;
  readonly name: string;
  readonly input: unknown;
  /** The exact tool_result text the control plane sent. */
  readonly content: string;
  /** `data` of the parsed envelope (undefined when the result was not an envelope). */
  readonly data: unknown;
  readonly isError: boolean;
}

export interface ReplayContext {
  readonly question: string;
  readonly steps: readonly ReplayStep[];
}

export interface ReplayToolCall {
  readonly name: string;
  readonly input: Record<string, unknown>;
}

export type ReplayDecision =
  | { readonly kind: 'tools'; readonly calls: readonly ReplayToolCall[] }
  | { readonly kind: 'answer'; readonly answer: AiStructuredAnswer };

export type ReplayPolicy = (context: ReplayContext) => ReplayDecision;

const MAX_BODY_BYTES = 8 * 1024 * 1024;
const VALIDATION_REPLY = 'OK';

interface WireBlock {
  type?: unknown;
  id?: unknown;
  name?: unknown;
  input?: unknown;
  tool_use_id?: unknown;
  content?: unknown;
  is_error?: unknown;
  text?: unknown;
}

interface WireMessage {
  role?: unknown;
  content?: unknown;
}

function blocks(message: WireMessage): WireBlock[] {
  return Array.isArray(message.content) ? (message.content as WireBlock[]) : [];
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return (content as WireBlock[]).map((block) => (typeof block.text === 'string' ? block.text : '')).join('');
}

function envelopeData(content: string): unknown {
  try {
    const parsed = JSON.parse(content) as unknown;
    if (typeof parsed === 'object' && parsed !== null && 'data' in parsed) return (parsed as { data: unknown }).data;
  } catch {
    // not an envelope (an error text)
  }
  return undefined;
}

/** The current question (the last plain user turn) and the tool steps that followed it. */
export function readContext(messages: readonly WireMessage[]): ReplayContext {
  let questionIndex = -1;
  messages.forEach((message, index) => {
    if (message.role === 'user' && typeof message.content === 'string') questionIndex = index;
  });
  const question = questionIndex === -1 ? '' : String(messages[questionIndex]?.content);
  const calls = new Map<string, { name: string; input: unknown }>();
  const steps: ReplayStep[] = [];
  for (const message of messages.slice(questionIndex + 1)) {
    for (const block of blocks(message)) {
      if (block.type === 'tool_use' && typeof block.id === 'string') {
        calls.set(block.id, { name: String(block.name), input: block.input });
      } else if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
        const call = calls.get(block.tool_use_id);
        const content = textOf(block.content);
        steps.push({
          id: block.tool_use_id,
          name: call?.name ?? 'unknown',
          input: call?.input,
          content,
          data: envelopeData(content),
          isError: block.is_error === true,
        });
      }
    }
  }
  return { question, steps };
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('replay provider: request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', reject);
  });
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

export class ReplayProvider {
  /** Raw body of every request the control plane sent, in order. */
  readonly requests: string[] = [];
  /** Tool names the policy asked for, in order (what the "model" decided). */
  readonly toolCallsIssued: string[] = [];
  #policy: ReplayPolicy | null = null;
  #counter = 0;
  readonly #server: Server;
  readonly #file: string;

  private constructor(server: Server, file: string) {
    this.#server = server;
    this.#file = file;
  }

  /** Listens on 127.0.0.1 and publishes the address to `file` (the seam reads it per call). */
  static async start(file: string): Promise<ReplayProvider> {
    let provider: ReplayProvider | null = null;
    const server = createServer((req, res) => {
      provider?.handle(req, res).catch(() => {
        if (!res.headersSent) send(res, 500, { type: 'error', error: { type: 'api_error', message: 'replay failure' } });
        else res.end();
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        resolve();
      });
    });
    provider = new ReplayProvider(server, file);
    const { port } = server.address() as AddressInfo;
    writeFileSync(file, `127.0.0.1:${String(port)}\n`);
    return provider;
  }

  use(policy: ReplayPolicy): void {
    this.#policy = policy;
  }

  /** Every body the provider received, joined: for canary checks. */
  transcript(): string {
    return this.requests.join('\n');
  }

  async stop(): Promise<void> {
    try {
      unlinkSync(this.#file);
    } catch {
      // already gone
    }
    await new Promise<void>((resolve) => {
      this.#server.close(() => {
        resolve();
      });
      this.#server.closeAllConnections();
    });
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const raw = await readBody(req);
    this.requests.push(raw);
    if (req.method !== 'POST' || !(req.url ?? '').startsWith('/v1/messages')) {
      send(res, 404, { type: 'error', error: { type: 'not_found_error', message: 'replay: unsupported route' } });
      return;
    }
    const body = JSON.parse(raw) as { model?: unknown; messages?: unknown; tools?: unknown; stream?: unknown };
    if (body.stream === true) {
      send(res, 400, { type: 'error', error: { type: 'invalid_request_error', message: 'replay: streaming unsupported' } });
      return;
    }
    const model = typeof body.model === 'string' ? body.model : 'replay';
    const hasTools = Array.isArray(body.tools) && body.tools.length > 0;
    if (!hasTools) {
      send(res, 200, this.message(model, [{ type: 'text', text: VALIDATION_REPLY }], 'end_turn'));
      return;
    }
    const policy = this.#policy;
    if (policy === null) throw new Error('replay provider: no policy set');
    const decision = policy(readContext(Array.isArray(body.messages) ? (body.messages as WireMessage[]) : []));
    if (decision.kind === 'answer') {
      send(res, 200, this.message(model, [{ type: 'text', text: JSON.stringify(decision.answer) }], 'end_turn'));
      return;
    }
    const content = decision.calls.map((call) => {
      this.#counter += 1;
      this.toolCallsIssued.push(call.name);
      return { type: 'tool_use', id: `toolu_e2e_${String(this.#counter).padStart(4, '0')}`, name: call.name, input: call.input };
    });
    send(res, 200, this.message(model, content, 'tool_use'));
  }

  private message(model: string, content: unknown[], stopReason: 'end_turn' | 'tool_use'): Record<string, unknown> {
    this.#counter += 1;
    return {
      id: `msg_e2e_${String(this.#counter).padStart(4, '0')}`,
      type: 'message',
      role: 'assistant',
      model,
      content,
      stop_reason: stopReason,
      stop_sequence: null,
      usage: { input_tokens: 100, output_tokens: 50 },
    };
  }
}
