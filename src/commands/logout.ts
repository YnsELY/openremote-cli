import { log } from "../lib/logger.js";
import { updateConfig } from "../lib/config.js";
import {
  clearApiKey,
  clearAuthToken,
  hasAuthToken,
} from "../lib/credentials.js";
import { confirm } from "../lib/prompt.js";

export async function logoutCommand(): Promise<void> {
  log.header("OpenRemote");

  if (!hasAuthToken()) {
    log.card("You're already signed out", ["No machine token is stored on this machine."], "warning");
    return;
  }

  const alsoKey = await confirm("Also remove the stored OpenAI API key?");

  clearAuthToken();
  if (alsoKey) {
    clearApiKey();
  }

  updateConfig({ userDisplayName: null });

  log.ok("Signed out");
  log.card(
    "Local credentials updated",
    [alsoKey ? "Removed machine token and API key." : "Removed machine token."],
    "success",
  );
  log.nextStep("Run openremote login when you're ready");
}
