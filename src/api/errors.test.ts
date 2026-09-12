import { describe, expect, it } from "vitest";
import { ApiRequestError, describeError, readApiResponse } from "@/api/errors";

describe("describeError", () => {
  it("keeps ordinary error text", () => {
    expect(describeError(new Error("The request was rejected."))).toBe("The request was rejected.");
  });

  it("uses a useful top-level message from a serialized object", () => {
    expect(describeError(new Error('{"message":"The session expired."}'))).toBe(
      "The session expired."
    );
  });

  it.each(['{}', '{"url":"https://auth.example.test/recover"}'])(
    "uses the fallback for diagnostic-only serialized objects (%s)",
    (message) => {
      expect(describeError(new Error(message), "Please try again.")).toBe("Please try again.");
    }
  );

  it("keeps a request ID when using the fallback", () => {
    const error = new ApiRequestError(
      503,
      { error: { message: '{"url":"https://auth.example.test/recover"}', request_id: "req_42" } },
      ""
    );

    expect(describeError(error, "Authentication is temporarily unavailable.")).toBe(
      "Authentication is temporarily unavailable. (Request ID: req_42)"
    );
  });

  it("retains response diagnostics and cause when formatting the user message", () => {
    const body = {
      error: {
        message: '{"url":"https://auth.example.test/recover"}',
        request_id: "req_43",
      },
    };
    const cause = new Error("provider response details");
    const error = new ApiRequestError(
      503,
      body,
      JSON.stringify(body),
      cause,
      { "x-request-id": "req_header" }
    );

    expect(describeError(error, "Authentication is temporarily unavailable.")).toBe(
      "Authentication is temporarily unavailable. (Request ID: req_43)"
    );
    expect(error.cause).toBe(cause);
    expect(error.responseBody).toBe(body);
    expect(error.responseText).toBe(JSON.stringify(body));
    expect(error.responseHeaders.get("x-request-id")).toBe("req_header");
  });
});

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
      readApiResponse(
        new Response(responseText, {
          status: 409,
          headers: { "content-type": "application/json", "x-request-id": "req_header" },
        })
      )
    ).rejects.toMatchObject({
      name: "ApiRequestError",
      status: 409,
      code: "checkout_pending",
      requestId: "req_test",
      retryAt: "2026-09-07T20:00:00Z",
      responseBody: body,
      responseText,
      responseHeaders: expect.any(Headers),
      message: `Checkout is still pending. Retry after ${new Date(body.retry_at).toLocaleString()}.`,
    });

    const error = await readApiResponse(
      new Response(responseText, {
        status: 409,
        headers: { "x-request-id": "req_header" },
      })
    ).catch((value: unknown) => value);
    expect(error).toBeInstanceOf(ApiRequestError);
    expect((error as ApiRequestError).responseHeaders.get("x-request-id")).toBe("req_header");
  });

  it("retains non-JSON response output", async () => {
    await expect(
      readApiResponse(new Response("upstream failure", { status: 502 }))
    ).rejects.toMatchObject({
      name: "ApiRequestError",
      status: 502,
      responseBody: undefined,
      responseText: "upstream failure",
      message: "Request failed (502).",
    });
  });

  it("retains the parse cause, raw output, and headers for malformed successful JSON", async () => {
    await expect(
      readApiResponse(
        new Response("malformed upstream output", {
          status: 200,
          headers: { "x-request-id": "req_parse" },
        })
      )
    ).rejects.toMatchObject({
      status: 200,
      responseText: "malformed upstream output",
      responseHeaders: expect.any(Headers),
      cause: expect.any(SyntaxError),
    });
  });

  it("retains status and the read failure when response output is unavailable", async () => {
    const cause = new Error("body stream failed");
    const response = {
      status: 503,
      text: () => Promise.reject(cause),
    } as unknown as Response;

    await expect(readApiResponse(response)).rejects.toMatchObject({
      name: "ApiRequestError",
      status: 503,
      responseText: "",
      cause,
      message: "Request failed (503).",
    });
  });

  it("retains partial response text when the response stream fails", async () => {
    const cause = new Error("body stream failed after a partial read");
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new TextEncoder().encode("partial upstream output"));
        controller.error(cause);
      },
    });
    const response = new Response(stream, {
      status: 502,
      headers: { "x-request-id": "req_partial" },
    });

    await expect(readApiResponse(response)).rejects.toMatchObject({
      status: 502,
      responseText: "partial upstream output",
      responseHeaders: expect.any(Headers),
      cause,
    });
  });

  it("is an Error for existing error handling", () => {
    expect(new ApiRequestError(500, undefined, "")).toBeInstanceOf(Error);
  });
});
