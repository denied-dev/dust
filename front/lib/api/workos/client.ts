import config from "@app/lib/api/config";
import { WorkOS } from "@workos-inc/node";

let workos: WorkOS | null = null;

export function getWorkOS() {
  // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing
  if (!workos) {
    const apiHostname = process.env.WORKOS_API_HOSTNAME ?? "auth-api.dust.tt";
    workos = new WorkOS(config.getWorkOSApiKey(), {
      clientId: config.getWorkOSClientId(),
      apiHostname,
    });
  }

  return workos;
}
