"use client";

import { createContext, useContext, useState, useCallback, type ReactNode } from "react";

interface BreadcrumbOverrideContextType {
  override: string | null;
  setOverride: (label: string | null) => void;
}

const BreadcrumbOverrideContext = createContext<BreadcrumbOverrideContextType>({
  override: null,
  setOverride: () => {},
});

export function BreadcrumbOverrideProvider({ children }: { children: ReactNode }) {
  const [override, setOverrideState] = useState<string | null>(null);
  const setOverride = useCallback((label: string | null) => setOverrideState(label), []);
  return (
    <BreadcrumbOverrideContext.Provider value={{ override, setOverride }}>
      {children}
    </BreadcrumbOverrideContext.Provider>
  );
}

export function useBreadcrumbOverride() {
  return useContext(BreadcrumbOverrideContext);
}
