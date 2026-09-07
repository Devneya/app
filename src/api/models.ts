import type { ModelsListResponse } from "@/api/types";
import { throwApiRequestError } from "@/api/errors";
import { config } from "@/config";

/** Public catalog — matches GET /llm/v1/models (no auth required). */
export async function fetchModels(): Promise<ModelsListResponse> {
  const resp = await fetch(`${config.apiBaseUrl.replace(/\/$/, "")}/llm/v1/models`);
  if (!resp.ok) {
    await throwApiRequestError(resp);
  }
  return resp.json() as Promise<ModelsListResponse>;
}
