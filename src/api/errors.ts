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
  readonly code?: string;
  readonly requestId?: string;
  readonly retryAt?: string;

  constructor(status: number, responseBody: unknown, responseText: string, cause?: unknown) {
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
    this.code = typeof envelope?.error?.code === "string" ? envelope.error.code : undefined;
    this.requestId =
      typeof envelope?.error?.request_id === "string" ? envelope.error.request_id : undefined;
    this.retryAt = typeof envelope?.retry_at === "string" ? envelope.retry_at : undefined;
  }
}

export function describeError(error: unknown, fallback = "Request failed"): string {
  if (!(error instanceof Error) || !error.message || error.message === "{}") {
    return fallback;
  }
  if (error instanceof ApiRequestError && error.requestId) {
    return `${error.message} (Request ID: ${error.requestId})`;
  }
  return error.message;
}

export async function throwApiRequestError(response: Response): Promise<never> {
  let responseText: string;
  try {
    responseText = await response.text();
  } catch (cause) {
    throw new ApiRequestError(response.status, undefined, "", cause);
  }
  let responseBody: unknown;
  try {
    responseBody = JSON.parse(responseText);
  } catch {
    responseBody = undefined;
  }
  throw new ApiRequestError(response.status, responseBody, responseText);
}
