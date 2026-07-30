import { defineConfig } from "vite";
import fs from "fs";
import path from "path";
import react from "@vitejs/plugin-react";

const isDev = process.env.NODE_ENV === "development";

// Languages offered in the UI. Defaults to all supported languages on
// dev/local and drops Arabic on prod; an explicit ENABLED_LANGUAGES env var
// (comma-separated codes) overrides both. Kept in sync with the deploy-time
// logic in lib/user-interface/index.ts.
const ALL_LANGUAGES = ["en", "es", "zh", "vi", "ar"];
const PROD_LANGUAGES = ["en", "es", "zh", "vi"];
function resolveEnabledLanguages(): string[] {
  const override = process.env.ENABLED_LANGUAGES;
  if (override) {
    return override.split(",").map((s) => s.trim()).filter(Boolean);
  }
  const env = process.env.ENVIRONMENT || process.env.NODE_ENV;
  return env === "prod" || env === "production" ? PROD_LANGUAGES : ALL_LANGUAGES;
}

// Optional features offered in the UI, same mechanism as the languages above.
// Defaults to every feature on dev/local and none on prod, where TTS,
// referrals and the parent-name gate ship as code but stay dark; an explicit
// ENABLED_FEATURES env var (comma-separated names) overrides both. Kept in
// sync with the deploy-time logic in lib/user-interface/index.ts, and with the
// feature list in src/common/features.ts.
const ALL_FEATURES = ["tts", "referrals", "parentNameGate"];
const PROD_FEATURES: string[] = [];
function resolveEnabledFeatures(): string[] {
  const override = process.env.ENABLED_FEATURES;
  if (override) {
    return override.split(",").map((s) => s.trim()).filter(Boolean);
  }
  const env = process.env.ENVIRONMENT || process.env.NODE_ENV;
  return env === "prod" || env === "production" ? PROD_FEATURES : ALL_FEATURES;
}

// https://vitejs.dev/config/
export default defineConfig({
  define: {
    "process.env": {},
  },
  plugins: [
    isDev && {
      name: "aws-exports",
      writeBundle() {
        const outputPath = path.resolve("public/aws-exports.json");

        // Write the modified JSON data to the public folder
        fs.writeFileSync(
          outputPath,
          JSON.stringify(
            {
              aws_project_region: process.env.AWS_PROJECT_REGION,
              aws_cognito_region: process.env.AWS_COGNITO_REGION,
              aws_user_pools_id: process.env.AWS_USER_POOLS_ID,
              aws_user_pools_web_client_id:
                process.env.AWS_USER_POOLS_WEB_CLIENT_ID,
              enabledLanguages: resolveEnabledLanguages(),
              enabledFeatures: resolveEnabledFeatures(),
              config: {
                api_endpoint: `https://${process.env.API_DISTRIBUTION_DOMAIN_NAME}/api`,
                websocket_endpoint: `wss://${process.env.API_DISTRIBUTION_DOMAIN_NAME}/socket`,
                rag_enabled: ["T", "t", "true", "True", "TRUE", "1"].includes(
                  process.env.RAG_ENABLED
                ),
                default_embeddings_model: process.env.DEFAULT_EMBEDDINGS_MODEL,
                default_cross_encoder_model:
                  process.env.DEFAULT_CROSS_ENCODER_MODEL,
              },
            },
            null,
            2
          ),
          "utf-8"
        );
      },
    },
    react(),
  ],
  server: {
    port: 3000,
  },
});
