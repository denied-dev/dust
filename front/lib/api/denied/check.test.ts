import { checkDeniedAuthorization } from "@app/lib/api/denied/check";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const DEFAULT_PARAMS = {
  userId: "user_abc123",
  agentSId: "agent_xyz",
  toolName: "google_calendar_list_events",
  mcpServerName: "google_calendar",
  inputs: { date: "2026-02-19" },
  conversationSId: "conv_123",
  step: 0,
};

// Mock config to control DENIED_API_URL and DENIED_API_KEY.
vi.mock("@app/lib/api/config", () => ({
  default: {
    getDeniedApiUrl: vi.fn(),
    getDeniedApiKey: vi.fn(),
  },
}));

// Suppress logger output in tests.
vi.mock("@app/logger/logger", () => ({
  default: {
    warn: vi.fn(),
  },
}));

describe("checkDeniedAuthorization", () => {
  let mockedGetUrl: ReturnType<typeof vi.fn>;
  let mockedGetKey: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.restoreAllMocks();
    const { default: config } = await import("@app/lib/api/config");
    mockedGetUrl = vi.mocked(config.getDeniedApiUrl);
    mockedGetKey = vi.mocked(config.getDeniedApiKey);
    mockedGetUrl.mockReturnValue("http://localhost:8181");
    mockedGetKey.mockReturnValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns allow when DENIED_API_URL is not set", async () => {
    mockedGetUrl.mockReturnValue(undefined);

    const result = await checkDeniedAuthorization(DEFAULT_PARAMS);

    expect(result.decision).toBe(true);
  });

  it("returns allow when PDP responds with decision: true", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ decision: true, context: null }), {
        status: 200,
      })
    );

    const result = await checkDeniedAuthorization(DEFAULT_PARAMS);

    expect(result.decision).toBe(true);
    expect(fetchSpy).toHaveBeenCalledOnce();

    const [url, options] = fetchSpy.mock.calls[0];
    expect(url).toBe("http://localhost:8181/pdp/check");
    expect(options?.method).toBe("POST");

    const body = JSON.parse(options?.body as string);
    expect(body.subject).toEqual({
      type: "user",
      id: "user_abc123",
      properties: {},
    });
    expect(body.resource).toEqual({
      type: "mcp_tool",
      id: "google_calendar_list_events",
      properties: { server: "google_calendar" },
    });
    expect(body.action.name).toBe("execute");
  });

  it("sends X-API-Key header when API key is configured", async () => {
    mockedGetKey.mockReturnValue("dnd_sk_test_key_123");
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(JSON.stringify({ decision: true }), { status: 200 })
      );

    await checkDeniedAuthorization(DEFAULT_PARAMS);

    const headers = fetchSpy.mock.calls[0][1]?.headers as Record<
      string,
      string
    >;
    expect(headers["X-API-Key"]).toBe("dnd_sk_test_key_123");
  });

  it("omits X-API-Key header when API key is not configured", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(JSON.stringify({ decision: true }), { status: 200 })
      );

    await checkDeniedAuthorization(DEFAULT_PARAMS);

    const headers = fetchSpy.mock.calls[0][1]?.headers as Record<
      string,
      string
    >;
    expect(headers["X-API-Key"]).toBeUndefined();
  });

  it("returns deny with reason when PDP responds with decision: false", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          decision: false,
          context: { reason: "Policy: no calendar access after email read" },
        }),
        { status: 200 }
      )
    );

    const result = await checkDeniedAuthorization(DEFAULT_PARAMS);

    expect(result.decision).toBe(false);
    expect(result.reason).toBe("Policy: no calendar access after email read");
  });

  it("returns deny with null reason when PDP denies without reason", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ decision: false }), { status: 200 })
    );

    const result = await checkDeniedAuthorization(DEFAULT_PARAMS);

    expect(result.decision).toBe(false);
    expect(result.reason).toBeNull();
  });

  it("fails open when PDP returns non-OK status", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("Internal Server Error", { status: 500 })
    );

    const result = await checkDeniedAuthorization(DEFAULT_PARAMS);

    expect(result.decision).toBe(true);
  });

  it("fails open when fetch throws (network error)", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ECONNREFUSED"));

    const result = await checkDeniedAuthorization(DEFAULT_PARAMS);

    expect(result.decision).toBe(true);
  });

  it("fails open when fetch is aborted (timeout)", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(
      new DOMException("The operation was aborted", "AbortError")
    );

    const result = await checkDeniedAuthorization(DEFAULT_PARAMS);

    expect(result.decision).toBe(true);
  });

  it("uses 'anonymous' as subject id when userId is undefined", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(JSON.stringify({ decision: true }), { status: 200 })
      );

    await checkDeniedAuthorization({ ...DEFAULT_PARAMS, userId: undefined });

    const body = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string);
    expect(body.subject.id).toBe("anonymous");
  });
});
