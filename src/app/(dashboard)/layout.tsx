export const dynamic = "force-dynamic";
import { SidebarProvider, SidebarInset } from "@/components/ui/sidebar";
import { AppSidebar } from "@/components/layout/sidebar";
import { AppHeader } from "@/components/layout/header";
import { ChatPanel } from "@/components/chat/chat-panel";
import { CommandPalette } from "@/components/command-palette";
import { Providers } from "@/components/providers";
import { BreadcrumbOverrideProvider } from "@/components/layout/breadcrumb-context";
import { Toaster } from "sonner";

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <Providers>
      <BreadcrumbOverrideProvider>
      <SidebarProvider>
        <AppSidebar />
        <SidebarInset>
          <AppHeader />
          <main className="flex-1 overflow-auto p-4 md:p-6">{children}</main>
        </SidebarInset>
        <ChatPanel />
        <CommandPalette />
        <Toaster position="bottom-right" richColors />
      </SidebarProvider>
      </BreadcrumbOverrideProvider>
    </Providers>
  );
}
