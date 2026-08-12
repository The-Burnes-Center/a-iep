import { useEffect, useState } from "react";
import { BrowserRouter } from "react-router-dom";
import { Amplify } from "aws-amplify";
import { AppConfig } from "../common/types";
import { AppContext } from "../common/app-context";
import { LanguageProvider } from "../common/language-context";
import { AuthProvider } from "../common/auth-provider";
import { Alert, Spinner } from "react-bootstrap";
import { initAnalytics } from "../common/helpers/analytics-helper";
import AppRoutes from "./AppRoutes";
import { NotificationProvider } from "./notif-manager";
import NotificationToasts from "./NotificationToasts";
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';


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
        Amplify.configure(awsExports);

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
  //   LanguageProvider > AuthProvider > QueryClientProvider > BrowserRouter >
  //   NotificationProvider > AppRoutes
  // This order is correct: no outer provider depends on hooks from an inner one.
  //
  // NotificationProvider sits here, and not inside AppRoutes, for two reasons.
  // It has to be under LanguageProvider, because the toast chrome calls t() and
  // LanguageProvider renders nothing until a dictionary has loaded. And it has
  // to be OUTSIDE <Routes>, which AppRoutes owns: the profile forms and the
  // delete flows all raise a notification and then navigate, so a queue that
  // lived inside the route element would unmount with the page that filled it.
  // NotificationToasts is a sibling of AppRoutes for the same reason.
  return (
    <AppContext.Provider value={config}>
      <LanguageProvider>
        <AuthProvider>
          <QueryClientProvider client={queryClient}>
            <BrowserRouter>
              <NotificationProvider>
                <NotificationToasts />
                <AppRoutes />
              </NotificationProvider>
            </BrowserRouter>
          </QueryClientProvider>
        </AuthProvider>
      </LanguageProvider>
    </AppContext.Provider>
  );
}