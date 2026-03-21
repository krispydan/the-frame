export const dynamic = "force-dynamic";

export default function SettingsPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Settings</h1>
        <p className="text-muted-foreground">
          Configure The Frame — coming soon
        </p>
      </div>
      <div className="rounded-lg border bg-card p-8 text-center text-muted-foreground">
        <p className="text-lg">Settings module is under development.</p>
        <p className="text-sm mt-2">API keys, integrations, team management, and preferences will be configured here.</p>
      </div>
    </div>
  );
}
