import type { ModelsListResponse } from "@/api/types";
import { config } from "@/config";

/** Public catalog — matches GET /llm/v1/models (no auth required). */
export async function fetchModels(): Promise<ModelsListResponse> {
  const resp = await fetch(`${config.apiBaseUrl.replace(/\/$/, "")}/llm/v1/models`);
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`/llm/v1/models failed (${resp.status}): ${body}`);
  }
  return resp.json() as Promise<ModelsListResponse>;
}
