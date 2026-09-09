import { describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { fetchModels } from "@/api/models";
import { config } from "@/config";
import { server } from "@/mocks/server";

const modelsURL = `${config.apiBaseUrl}/llm/v1/models`;

describe("models API response checks", () => {
  it("retains the invalid response payload as the validation cause", async () => {
    const invalidPayload = { object: "list", data: [{ object: "model" }] };
    server.use(http.get(modelsURL, () => HttpResponse.json(invalidPayload)));

    await expect(fetchModels()).rejects.toMatchObject({
      message: "Models response was invalid.",
      cause: invalidPayload,
    });
  });

  it("preserves extra supported fields in the catalog response", async () => {
    server.use(
      http.get(modelsURL, () =>
        HttpResponse.json({
          object: "list",
          provider_field: "kept",
          data: [{ id: "model_test", object: "model", provider_field: "kept" }],
        })
      )
    );

    await expect(fetchModels()).resolves.toMatchObject({
      object: "list",
      provider_field: "kept",
      data: [{ id: "model_test", provider_field: "kept" }],
    });
  });

  it("uses the shared error response with status, body, and headers", async () => {
    const body = { error: { code: "catalog_unavailable", message: "Unavailable." } };
    server.use(
      http.get(
        modelsURL,
        () =>
          HttpResponse.json(body, {
            status: 503,
            headers: { "x-request-id": "req_models" },
          })
      )
    );

    await expect(fetchModels()).rejects.toMatchObject({
      status: 503,
      responseBody: body,
      responseText: JSON.stringify(body),
      responseHeaders: expect.any(Headers),
    });
  });
});
