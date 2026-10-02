// The X (Twitter) account feature — pool accounts assigned to projects and posting through them — is OFF
// (owner 2026-10-02: "sitedeki illegal şeyleri kaldır, twitter oluşturma gibi"). Nothing is charged for it,
// no account is assigned, no post is sent, and the pages do not show it. The official coin still links the
// team's own @AutonomPF. Set AUTONOM_X_FEATURE=1 to switch the feature back on.
import { env } from "./env.mjs";
export const X_FEATURE_ENABLED = env("AUTONOM_X_FEATURE", "0") === "1";
