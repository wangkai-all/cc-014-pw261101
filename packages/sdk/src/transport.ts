export interface ItemAck {
  event_id: string;
  status: 'accepted' | 'duplicate' | 'rejected';
  errors?: unknown;
}

export interface BatchResponse {
  httpStatus: number;
  /** 服务端正常响应（含逐条结果） */
  body?: {
    accepted: number;
    duplicate: number;
    rejected: number;
    results: ItemAck[];
  };
  /** 网络层/超时错误：结果未知，必须靠 event_id 幂等重试 */
  networkError?: 'offline' | 'timeout' | 'error';
  errorMessage?: string;
}

export interface Transport {
  sendBatch(endpoint: string, batch: unknown[], timeoutMs: number): Promise<BatchResponse>;
}

export const defaultTransport: Transport = {
  async sendBatch(endpoint, batch, timeoutMs): Promise<BatchResponse> {
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      return { httpStatus: 0, networkError: 'offline' };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ events: batch }),
        signal: controller.signal,
      });
      const text = await res.text();
      let body: BatchResponse['body'];
      try {
        body = text ? (JSON.parse(text) as BatchResponse['body']) : undefined;
      } catch {
        return { httpStatus: res.status, networkError: 'error', errorMessage: 'invalid JSON response' };
      }
      return { httpStatus: res.status, body };
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        // 浏览器超时但服务端可能已落库：不做本地去重，带原 event_id 重试，由服务端幂等
        return { httpStatus: 0, networkError: 'timeout' };
      }
      return {
        httpStatus: 0,
        networkError: typeof navigator !== 'undefined' && navigator.onLine === false ? 'offline' : 'error',
        errorMessage: err instanceof Error ? err.message : String(err),
      };
    } finally {
      clearTimeout(timer);
    }
  },
};
