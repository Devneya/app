import type { ModelsListResponse } from "@/api/types";
import { throwApiRequestError } from "@/api/errors";
import { config } from "@/config";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Public catalog — matches GET /llm/v1/models (no auth required). */
export async function fetchModels(): Promise<ModelsListResponse> {
  const resp = await fetch(`${config.apiBaseUrl}/llm/v1/models`);
  if (!resp.ok) {
    await throwApiRequestError(resp);
  }
  const value: unknown = await resp.json();
  if (
    !isRecord(value) ||
    !Array.isArray(value.data) ||
    value.data.some(
      (model: unknown) =>
        !isRecord(model) ||
        typeof model.id !== "string" ||
        !model.id.trim()
    )
  ) {
    throw new Error("Models response was invalid.");
  }
  return value as ModelsListResponse;
}
