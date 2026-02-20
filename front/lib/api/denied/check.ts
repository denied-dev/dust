import config from "@app/lib/api/config";
import logger from "@app/logger/logger";

const DENIED_CHECK_TIMEOUT_MS = 500;

interface DeniedCheckParams {
  userId: string | undefined;
  agentSId: string;
  toolName: string;
  mcpServerName: string;
  inputs: Record<string, unknown>;
  conversationSId: string;
  step: number;
}

interface DeniedCheckResult {
  decision: boolean;
  reason: string | null;
}

/**
 * Call the Denied API /pdp/check endpoint to authorize a tool call.
 *
 * Returns { decision: true } (allow) when:
 * - DENIED_API_URL is not configured (feature off)
 * - The PDP returns decision: true
 * - The PDP is unreachable or times out (fail-open)
 *
 * Returns { decision: false, reason } when the PDP explicitly denies the action.
 */
export async function checkDeniedAuthorization(
  params: DeniedCheckParams
): Promise<DeniedCheckResult> {
  const deniedApiUrl = config.getDeniedApiUrl();
  if (!deniedApiUrl) {
    return { decision: true, reason: null };
  }

  const body = {
    subject: {
      type: "user",
      id: params.userId ?? "anonymous",
      properties: {},
    },
    resource: {
      type: "mcp_tool",
      id: params.toolName,
      properties: {
        server: params.mcpServerName,
        inputs: params.inputs,
      },
    },
    action: {
      name: "execute",
      properties: {},
    },
    context: {
      agent: params.agentSId,
      conversation: params.conversationSId,
      step: params.step,
    },
  };

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(
      () => controller.abort(),
      DENIED_CHECK_TIMEOUT_MS
    );

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    const deniedApiKey = config.getDeniedApiKey();
    if (deniedApiKey) {
      headers["X-API-Key"] = deniedApiKey;
    }

    // eslint-disable-next-line no-restricted-globals
    const response = await fetch(`${deniedApiUrl}/pdp/check`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      logger.warn(
        {
          status: response.status,
          deniedApiUrl,
          toolName: params.toolName,
        },
        "Denied API returned non-OK status, failing open"
      );
      return { decision: true, reason: null };
    }

    const data: { decision: boolean; context?: { reason?: string } } =
      await response.json();

    return {
      decision: data.decision,
      reason: data.context?.reason ?? null,
    };
  } catch (err) {
    logger.warn(
      {
        err,
        deniedApiUrl,
        toolName: params.toolName,
      },
      "Denied API check failed, failing open"
    );
    return { decision: true, reason: null };
  }
}
