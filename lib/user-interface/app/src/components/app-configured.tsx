import { useEffect, useState } from "react";
import { BrowserRouter } from "react-router-dom";
import { Amplify } from "aws-amplify";
import { AppConfig } from "../common/types";
import { AppContext } from "../common/app-context";
import { LanguageProvider } from "../common/language-context";
import { AuthProvider } from "../common/auth-provider";
import { Alert, StatusIndicator } from "@cloudscape-design/components";
import { StorageHelper } from "../common/helpers/storage-helper";
import { Mode } from "@cloudscape-design/global-styles";
import AppRoutes from "./AppRoutes";
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
  const [theme, setTheme] = useState(StorageHelper.getTheme());
  const [isLoading, setIsLoading] = useState<boolean>(true);

  // Load AWS configuration on mount
  useEffect(() => {
    const loadConfig = async () => {
      try {
        const result = await fetch("/aws-exports.json");
        const awsExports = await result.json();

        // Configure Amplify once
        Amplify.configure(awsExports);

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

  // Theme management
  useEffect(() => {
    const observer = new MutationObserver((mutations) => {
      mutations.forEach((mutation) => {
        if (
          mutation.type === "attributes" &&
          mutation.attributeName === "style"
        ) {
          const newValue =
            document.documentElement.style.getPropertyValue(
              "--app-color-scheme"
            );

          const mode = newValue === "dark" ? Mode.Dark : Mode.Light;
          if (mode !== theme) {
            setTheme(mode);
          }
        }
      });
    });

    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["style"],
    });

    return () => {
      observer.disconnect();
    };
  }, [theme]);

  // Loading state
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
        <StatusIndicator type="loading">Loading configuration...</StatusIndicator>
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
        <Alert header="Configuration error" type="error">
          Error loading configuration from "
          <a href="/aws-exports.json" style={{ fontWeight: "600" }}>
            /aws-exports.json
          </a>
          "
        </Alert>
      </div>
    );
  }

  // Always render the router with all providers
  // The router will handle showing login vs protected routes based on auth state
  // Provider hierarchy: LanguageProvider > AuthProvider > QueryClientProvider > BrowserRouter
  // This order is correct — no outer provider depends on hooks from an inner one
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