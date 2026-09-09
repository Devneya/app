import type { ModelsListResponse } from "@/api/types";
import { readApiResponse } from "@/api/errors";
import { config } from "@/config";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Public catalog — matches GET /llm/v1/models (no auth required). */
export async function fetchModels(): Promise<ModelsListResponse> {
  const resp = await fetch(`${config.apiBaseUrl}/llm/v1/models`);
  const value = await readApiResponse(resp);
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
    throw new Error("Models response was invalid.", { cause: value });
  }
  return value as ModelsListResponse;
}
