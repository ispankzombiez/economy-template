import React, { createContext, useContext } from "react";
import type { BootstrapContext as BootstrapContextType } from "./types";

const BootstrapContext = createContext<BootstrapContextType | null>(null);

export function BootstrapProvider({
  bootstrap,
  children,
}: {
  bootstrap: BootstrapContextType;
  children: React.ReactNode;
}) {
  return <BootstrapContext.Provider value={bootstrap}>{children}</BootstrapContext.Provider>;
}

export function useBootstrap(): BootstrapContextType {
  const ctx = useContext(BootstrapContext);
  if (!ctx) {
    if (process.env.NODE_ENV !== "production") {
      console.error("useBootstrap called outside BootstrapProvider. Component stack:", new Error().stack);
    }
    throw new Error("useBootstrap must be used within a BootstrapProvider");
  }
  return ctx;
}

export default BootstrapContext;