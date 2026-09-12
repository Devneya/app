type ErrorEnvelope = {
  error?: {
    code?: unknown;
    message?: unknown;
    request_id?: unknown;
  };
  retry_at?: unknown;
};

function isErrorEnvelope(value: unknown): value is ErrorEnvelope {
  return typeof value === "object" && value !== null;
}

export class ApiRequestError extends Error {
  readonly status: number;
  readonly responseBody: unknown;
  readonly responseText: string;
  readonly responseHeaders: Headers;
  readonly code?: string;
  readonly requestId?: string;
  readonly retryAt?: string;

  constructor(
    status: number,
    responseBody: unknown,
    responseText: string,
    cause?: unknown,
    responseHeaders: HeadersInit = {}
  ) {
    const envelope = isErrorEnvelope(responseBody) ? responseBody : undefined;
    const baseMessage =
      typeof envelope?.error?.message === "string"
        ? envelope.error.message
        : `Request failed (${status}).`;
    const message =
      typeof envelope?.retry_at === "string"
        ? `${baseMessage} Retry after ${new Date(envelope.retry_at).toLocaleString()}.`
        : baseMessage;
    super(message, { cause });
    this.name = "ApiRequestError";
    this.status = status;
    this.responseBody = responseBody;
    this.responseText = responseText;
    this.responseHeaders = new Headers(responseHeaders);
    this.code = typeof envelope?.error?.code === "string" ? envelope.error.code : undefined;
    this.requestId =
      typeof envelope?.error?.request_id === "string" ? envelope.error.request_id : undefined;
    this.retryAt = typeof envelope?.retry_at === "string" ? envelope.retry_at : undefined;
  }
}

class ResponseBodyReadError extends Error {
  readonly partialText: string;

  constructor(partialText: string, cause: unknown) {
    super("Failed to read the response body.", { cause });
    this.name = "ResponseBodyReadError";
    this.partialText = partialText;
  }
}

function responseBody(value: string): { parsed: boolean; value: unknown; cause?: unknown } {
  try {
    return { parsed: true, value: JSON.parse(value) };
  } catch (cause) {
    return { parsed: false, value: undefined, cause };
  }
}

async function readResponseText(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) {
    try {
      return await response.text();
    } catch (cause) {
      throw new ResponseBodyReadError("", cause);
    }
  }

  const decoder = new TextDecoder();
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        return text + decoder.decode();
      }
      text += decoder.decode(value, { stream: true });
    }
  } catch (cause) {
    throw new ResponseBodyReadError(text + decoder.decode(), cause);
  } finally {
    reader.releaseLock();
  }
}

export async function readApiResponse(response: Response): Promise<unknown> {
  const responseHeaders = new Headers(response.headers);
  let responseText: string;
  try {
    responseText = await readResponseText(response);
  } catch (error) {
    if (error instanceof ResponseBodyReadError) {
      const parsed = responseBody(error.partialText);
      throw new ApiRequestError(
        response.status,
        parsed.parsed ? parsed.value : undefined,
        error.partialText,
        error.cause,
        responseHeaders
      );
    }
    throw error;
  }

  const parsed = responseBody(responseText);
  if (!parsed.parsed) {
    throw new ApiRequestError(
      response.status,
      undefined,
      responseText,
      parsed.cause,
      responseHeaders
    );
  }
  if (!response.ok) {
    throw new ApiRequestError(
      response.status,
      parsed.value,
      responseText,
      undefined,
      responseHeaders
    );
  }
  return parsed.value;
}

function errorMessage(message: string | undefined, fallback: string): string {
  if (!message) {
    return fallback;
  }

  try {
    const value: unknown = JSON.parse(message);
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return message;
    }
    const text = (value as { message?: unknown }).message;
    return typeof text === "string" && text.trim() ? text : fallback;
  } catch {
    return message;
  }
}

export function describeError(error: unknown, fallback = "Request failed"): string {
  const message = errorMessage(error instanceof Error ? error.message : undefined, fallback);
  const requestId = error instanceof ApiRequestError ? error.requestId?.trim() : undefined;
  return requestId ? `${message} (Request ID: ${requestId})` : message;
}
