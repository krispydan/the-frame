"use client";

import { useEffect, useState } from "react";
import { Loader2, Save, RefreshCw, ChevronsUpDown, Check, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { toast } from "sonner";

type Account = { code: string; name: string; type: string; status: string };
type Mapping = {
  category: string;
  xeroAccountCode: string | null;
  xeroAccountName: string | null;
  notes: string | null;
  updatedAt: string | null;
};

const PLATFORM_LABELS: Record<string, string> = {
  shopify_dtc: "Shopify Retail (DTC)",
  shopify_wholesale: "Shopify Wholesale",
  faire: "Faire",
};

const CATEGORY_LABELS: Record<string, string> = {
  sales: "Sales",
  shipping: "Shipping income",
  discounts: "Discounts",
  refunds: "Refunds",
  tax: "Tax collected",
  fees: "Payment fees",
  adjustments: "Adjustments",
  bank_clearing: "Bank clearing",
};

const CATEGORY_HINTS: Record<string, string> = {
  sales: "Revenue from product sales (excl. tax / shipping). Usually a 4xxx Revenue account.",
  shipping: "Shipping charged to customers. Often a 4xxx Revenue account.",
  discounts: "Discount totals (will be debited). Often a 4xxx Discount contra-revenue account.",
  refunds: "Refunds issued to customers. Often a 4xxx Refunds contra-revenue account.",
  tax: "Sales tax collected. A 2xxx Liability account.",
  fees: "Payment processor fees deducted from the payout. A 6xxx Expense account.",
  adjustments: "Stripe / Shopify Payments adjustments. Usually 6xxx Expense or 4xxx contra-revenue.",
  bank_clearing: "The bank account that receives the net payout. A 1xxx Asset / Bank account.",
};

const PLATFORMS = ["shopify_dtc", "shopify_wholesale", "faire"];

/**
 * Searchable combobox for picking a Xero account by code or name.
 * Replaces the plain Select since the chart of accounts can have 100+ rows
 * and scrolling through them was painful.
 */
function AccountCombobox({
  accounts,
  value,
  onChange,
}: {
  accounts: Account[];
  value: string | null;
  onChange: (code: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const selected = value ? accounts.find((a) => a.code === value) : null;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            variant="outline"
            className="w-full justify-between font-normal min-w-[400px]"
            type="button"
          >
            {selected ? (
              <span className="flex items-center gap-2 truncate">
                <span className="font-mono text-xs text-muted-foreground">{selected.code}</span>
                <span className="truncate">{selected.name}</span>
                <span className="text-xs text-muted-foreground">{selected.type}</span>
              </span>
            ) : (
              <span className="text-muted-foreground">Select account...</span>
            )}
            <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
          </Button>
        }
      />
      <PopoverContent className="w-[500px] p-0" align="start">
        <Command
          filter={(itemValue, search) => {
            // Search against the entire item label (code + name + type, joined)
            return itemValue.toLowerCase().includes(search.toLowerCase()) ? 1 : 0;
          }}
        >
          <CommandInput placeholder="Search by code, name, or type..." />
          <CommandList>
            <CommandEmpty>No accounts match.</CommandEmpty>
            <CommandGroup>
              {value && (
                <CommandItem
                  value="__clear__ Not mapped"
                  onSelect={() => {
                    onChange(null);
                    setOpen(false);
                  }}
                  className="text-muted-foreground"
                >
                  <X className="mr-2 h-4 w-4" />
                  Clear mapping
                </CommandItem>
              )}
              {accounts.map((a) => {
                const isSelected = a.code === value;
                return (
                  <CommandItem
                    key={a.code}
                    value={`${a.code} ${a.name} ${a.type}`}
                    onSelect={() => {
                      onChange(a.code);
                      setOpen(false);
                    }}
                  >
                    <Check className={`mr-2 h-4 w-4 ${isSelected ? "opacity-100" : "opacity-0"}`} />
                    <span className="font-mono text-xs mr-2 w-12">{a.code}</span>
                    <span className="flex-1 truncate">{a.name}</span>
                    <span className="text-xs text-muted-foreground ml-2">{a.type}</span>
                  </CommandItem>
                );
              })}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

export function XeroAccountMapping() {
  const [activePlatform, setActivePlatform] = useState<string>("shopify_dtc");
  const [accounts, setAccounts] = useState<Account[] | null>(null);
  const [mappings, setMappings] = useState<Record<string, Mapping[]>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  async function loadAccounts() {
    const res = await fetch("/api/v1/integrations/xero/accounts");
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = data?.hint
        ? `${data.error || "Failed to load Xero accounts"} — ${data.hint}`
        : data?.error || "Failed to load Xero accounts";
      toast.error(msg);
      setAccounts([]);
      return;
    }
    setAccounts(data.accounts || []);
  }

  async function loadMappings(platform: string) {
    const res = await fetch(`/api/v1/integrations/xero/mappings?platform=${platform}`);
    if (!res.ok) return;
    const data = await res.json();
    setMappings((m) => ({ ...m, [platform]: data.mappings as Mapping[] }));
  }

  useEffect(() => {
    Promise.all([loadAccounts(), ...PLATFORMS.map(loadMappings)]).finally(() => setLoading(false));
  }, []);

  function updateLocal(platform: string, category: string, code: string | null) {
    setMappings((current) => {
      const list = current[platform] || [];
      const account = accounts?.find((a) => a.code === code) || null;
      return {
        ...current,
        [platform]: list.map((m) =>
          m.category === category
            ? { ...m, xeroAccountCode: code, xeroAccountName: account?.name ?? null }
            : m,
        ),
      };
    });
  }

  async function save(platform: string) {
    setSaving(true);
    try {
      const list = mappings[platform] || [];
      const res = await fetch("/api/v1/integrations/xero/mappings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          platform,
          mappings: list.map((m) => ({
            category: m.category,
            xeroAccountCode: m.xeroAccountCode,
            xeroAccountName: m.xeroAccountName,
            notes: m.notes,
          })),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to save");
      toast.success(`Saved ${data.upserted} mapping${data.upserted === 1 ? "" : "s"}${data.cleared ? `, cleared ${data.cleared}` : ""}`);
      await loadMappings(platform);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <Card>
        <CardContent className="pt-6 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 inline animate-spin mr-2" />Loading account mappings...</CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Account mapping</CardTitle>
        <CardDescription>
          Pick which Xero account each payout category posts to. Each platform (DTC, Wholesale, Faire) gets its own mapping so you can route them to different revenue/expense accounts.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex items-center justify-between mb-3">
          <div className="text-xs text-muted-foreground">
            {accounts?.length ?? 0} active Xero accounts loaded
          </div>
          <Button variant="ghost" size="sm" onClick={loadAccounts} disabled={loading}>
            <RefreshCw className="h-3 w-3 mr-1" />Refresh accounts
          </Button>
        </div>

        <Tabs value={activePlatform} onValueChange={(v) => setActivePlatform(v ?? "shopify_dtc")}>
          <TabsList className="grid grid-cols-3 max-w-lg">
            {PLATFORMS.map((p) => (
              <TabsTrigger key={p} value={p}>{PLATFORM_LABELS[p]}</TabsTrigger>
            ))}
          </TabsList>

          {PLATFORMS.map((platform) => (
            <TabsContent key={platform} value={platform} className="mt-4">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-[40%]">Category</TableHead>
                    <TableHead>Xero account</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(mappings[platform] || []).map((m) => (
                    <TableRow key={m.category}>
                      <TableCell>
                        <div className="font-medium">{CATEGORY_LABELS[m.category] || m.category}</div>
                        <div className="text-xs text-muted-foreground">{CATEGORY_HINTS[m.category]}</div>
                      </TableCell>
                      <TableCell>
                        <AccountCombobox
                          accounts={accounts || []}
                          value={m.xeroAccountCode}
                          onChange={(code) => updateLocal(platform, m.category, code)}
                        />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              <div className="mt-3 flex justify-end">
                <Button onClick={() => save(platform)} disabled={saving}>
                  <Save className="h-4 w-4 mr-2" />
                  Save {PLATFORM_LABELS[platform]} mappings
                </Button>
              </div>
            </TabsContent>
          ))}
        </Tabs>
      </CardContent>
    </Card>
  );
}
