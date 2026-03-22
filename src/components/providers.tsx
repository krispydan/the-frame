"use client";

import { TooltipProvider } from "@/components/ui/tooltip";
import { UserProvider } from "@/hooks/use-user";

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <UserProvider>
      <TooltipProvider>{children}</TooltipProvider>
    </UserProvider>
  );
}
