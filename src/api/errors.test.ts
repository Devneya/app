import { describe, expect, it } from "vitest";
import { ApiRequestError, throwApiRequestError } from "@/api/errors";

describe("ApiRequestError", () => {
  it("retains the structured API error and response metadata", async () => {
    const body = {
      error: {
        code: "checkout_pending",
        message: "Checkout is still pending.",
        request_id: "req_test",
      },
      retry_at: "2026-09-07T20:00:00Z",
    };
    const responseText = JSON.stringify(body);

    await expect(
      throwApiRequestError(new Response(responseText, { status: 409 }))
    ).rejects.toMatchObject({
      name: "ApiRequestError",
      status: 409,
      code: "checkout_pending",
      requestId: "req_test",
      retryAt: "2026-09-07T20:00:00Z",
      responseBody: body,
      responseText,
      message: `Checkout is still pending. Retry after ${new Date(body.retry_at).toLocaleString()}.`,
    });
  });

  it("retains non-JSON response output", async () => {
    await expect(
      throwApiRequestError(new Response("upstream failure", { status: 502 }))
    ).rejects.toMatchObject({
      name: "ApiRequestError",
      status: 502,
      responseBody: undefined,
      responseText: "upstream failure",
      message: "Request failed (502).",
    });
  });

  it("retains status and the read failure when response output is unavailable", async () => {
    const cause = new Error("body stream failed");
    const response = {
      status: 503,
      text: () => Promise.reject(cause),
    } as unknown as Response;

    await expect(throwApiRequestError(response)).rejects.toMatchObject({
      name: "ApiRequestError",
      status: 503,
      responseText: "",
      cause,
      message: "Request failed (503).",
    });
  });

  it("is an Error for existing error handling", () => {
    expect(new ApiRequestError(500, undefined, "")).toBeInstanceOf(Error);
  });
});
