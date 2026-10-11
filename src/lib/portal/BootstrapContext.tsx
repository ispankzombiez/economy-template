import React, { createContext, useContext } from "react";
import type { BootstrapContext } from "./types";

const BootstrapContext = createContext<BootstrapContext | null>(null);

export function BootstrapProvider({
  bootstrap,
  children,
}: {
  bootstrap: BootstrapContext;
  children: React.ReactNode;
}) {
  return <BootstrapContext.Provider value={bootstrap}>{children}</BootstrapContext.Provider>;
}

export function useBootstrap(): BootstrapContext {
  const ctx = useContext(BootstrapContext);
  if (!ctx) {
    throw new Error("useBootstrap must be used within a BootstrapProvider");
  }
  return ctx;
}

export default BootstrapContext;