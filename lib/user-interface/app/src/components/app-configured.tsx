import { useEffect, useState } from "react";
import { BrowserRouter } from "react-router-dom";
import { Amplify } from "aws-amplify";
import type { ResourcesConfig } from "aws-amplify";
import { AppConfig } from "../common/types";
import { AppContext } from "../common/app-context";
import { LanguageProvider } from "../common/language-context";
import { AuthProvider } from "../common/auth-provider";
import { Alert, Spinner } from "react-bootstrap";
import { initAnalytics } from "../common/helpers/analytics-helper";
import AppRoutes from "./AppRoutes";
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// Amplify v6 expects Auth.Cognito.*, while the CDK still publishes the v5-flat
// aws-exports.json shape (Auth.region / userPoolWebClientId / oauth.scope, with
// single-string redirects). Translate here so the deployed config file and every
// other consumer of AppConfig stay unchanged.
type V5Oauth = {
  domain?: string;
  scope?: string[];
  scopes?: string[];
  redirectSignIn?: string | string[];
  redirectSignOut?: string | string[];
  responseType?: string;
};
type V5AuthConfig = {
  region?: string;
  userPoolId?: string;
  userPoolWebClientId?: string;
  userPoolClientId?: string;
  oauth?: V5Oauth;
};

function toV6ResourcesConfig(cfg: { Auth?: V5AuthConfig } | undefined): ResourcesConfig {
  const auth: V5AuthConfig = cfg?.Auth ?? {};
  const oauth = auth.oauth;
  const asList = (v: string | string[] | undefined) =>
    Array.isArray(v) ? v : v ? [v] : [];
  // The shape is assembled from a JSON file fetched at runtime, so the
  // required-field guarantees of ResourcesConfig cannot be proven statically.
  return {
    Auth: {
      Cognito: {
        userPoolId: auth.userPoolId,
        // v6 renamed userPoolWebClientId -> userPoolClientId
        userPoolClientId: auth.userPoolWebClientId ?? auth.userPoolClientId,
        ...(oauth
          ? {
              loginWith: {
                oauth: {
                  domain: oauth.domain,
                  // v6 renamed scope -> scopes and takes redirects as arrays
                  scopes: oauth.scope ?? oauth.scopes ?? [],
                  redirectSignIn: asList(oauth.redirectSignIn),
                  redirectSignOut: asList(oauth.redirectSignOut ?? oauth.redirectSignIn),
                  responseType: (oauth.responseType ?? 'code') as 'code' | 'token',
                },
              },
            }
          : {}),
      },
    },
  } as unknown as ResourcesConfig;
}



const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 1000 * 60 * 5, // 5 minutes
        retry: 1,
      },
    },
  }); 

export default function AppConfigured() {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [error, setError] = useState<boolean | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(true);

  // Load AWS configuration on mount
  useEffect(() => {
    const loadConfig = async () => {
      try {
        const result = await fetch("/aws-exports.json");
        const awsExports = await result.json();

        // Configure Amplify once
        Amplify.configure(toV6ResourcesConfig(awsExports));

        // Analytics only on the prod deployment; staging and local dev
        // stay out of the production GA property.
        if (awsExports.environment === "prod") {
          initAnalytics();
        }

        setConfig(awsExports);
      } catch (e) {
        console.error("Error loading configuration:", e);
        setError(true);
      } finally {
        setIsLoading(false);
      }
    };
  
    loadConfig();
  }, []);

  // Loading state.
  // This renders ABOVE LanguageProvider, so t() does not exist yet and the
  // label here has to stay English. It is the boot screen for a fetch of a
  // static file on the same origin, so a parent sees it for a moment at most.
  if (isLoading) {
    return (
      <div
        style={{
          width: "100%",
          height: "100vh",
          display: "flex",
          justifyContent: "center",
          alignItems: "center",
        }}
      >
        <Spinner animation="border" role="status">
          <span className="visually-hidden">Loading configuration...</span>
        </Spinner>
      </div>
    );
  }

  // Error state
  if (error || !config) {
    return (
      <div
        style={{
          height: "100vh",
          width: "100%",
          display: "flex",
          justifyContent: "center",
          alignItems: "center",
        }}
      >
        {/* react-bootstrap's Alert carries role="alert" itself. Same reason as
            the loading state above: no t() this high in the tree. */}
        <Alert variant="danger">
          <Alert.Heading>Configuration error</Alert.Heading>
          Error loading configuration from "
          <Alert.Link href="/aws-exports.json" style={{ fontWeight: "600" }}>
            /aws-exports.json
          </Alert.Link>
          "
        </Alert>
      </div>
    );
  }

  // Always render the router with all providers
  // The router will handle showing login vs protected routes based on auth state
  // Provider hierarchy:
  //   LanguageProvider > AuthProvider > QueryClientProvider > BrowserRouter
  // This order is correct: no outer provider depends on hooks from an inner one.
  return (
    <AppContext.Provider value={config}>
      <LanguageProvider>
        <AuthProvider>
          <QueryClientProvider client={queryClient}>
            <BrowserRouter>
              <AppRoutes />
            </BrowserRouter>
          </QueryClientProvider>
        </AuthProvider>
      </LanguageProvider>
    </AppContext.Provider>
  );
}