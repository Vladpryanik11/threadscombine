export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface AiRequest {
  purpose: string; // for the journal: 'key-check', 'virality', …
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal; // cancellation by the user
}

export interface Usage {
  promptTokens: number;
  completionTokens: number;
  costUsd?: number;
}

export type AiErrorCode =
  | 'no_key'
  | 'no_model'
  | 'budget_exceeded'
  | 'bad_key'
  | 'no_credits'
  | 'rate_limited'
  | 'model_unavailable'
  | 'timeout'
  | 'network'
  | 'bad_output'
  | 'cancelled'
  | 'unknown';

export interface AiError {
  code: AiErrorCode;
  message: string; // in Russian, ready to show
  status?: number;
  model?: string;
}

export type AiResult<T> =
  | {
      ok: true;
      value: T;
      model: string;
      usage?: Usage;
      switchedFrom: string[];
      elapsedMs: number;
    }
  | { ok: false; error: AiError };

export interface ModelInfo {
  id: string;
  name: string;
  promptPricePerM: number; // $ per 1M tokens
  completionPricePerM: number; // $ per 1M tokens
  contextLength: number;
  supportsStructuredOutputs: boolean; // 'structured_outputs' in supported_parameters
  supportsReasoning: boolean; // 'reasoning' in supported_parameters
}
