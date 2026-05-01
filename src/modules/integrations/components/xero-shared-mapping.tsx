"use client";

import { useEffect, useState } from "react";
import { Loader2, Save, Sparkles, ChevronsUpDown, Check, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";

type Account = { code: string; name: string; type: string; status: string };
type Mapping = {
  category: string;
  label: string;
  hint: string;
  side: "credit" | "debit";
  defaultAccountCode: string | null;
  defaultAccountName: string | null;
  xeroAccountCode: string | null;
  xeroAccountName: string | null;
  notes: string | null;
};

const SHARED_PLATFORM = "_shared";

/**
 * Mapping picker for accounts that apply across every channel — currently
 * the single COGS expense account and the Inventory asset account.
 * Tracking categories split per-channel COGS on the P&L, so a single
 * GL account here is sufficient.
 *
 * Shares all the picker plumbing with XeroAccountMapping but renders just
 * the two shared rows in their own card so the user understands they're
 * global, not per-platform.
 */
export function XeroSharedMapping() {
  const [accounts, setAccounts] = useState<Account[] | null>(null);
  const [mappings, setMappings] = useState<Mapping[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  async function loadAccounts() {
    const res = await fetch("/api/v1/integrations/xero/accounts");
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      toast.error(data?.hint ? `${data.error || "Failed"} — ${data.hint}` : data?.error || "Failed to load Xero accounts");
      setAccounts([]);
      return;
    }
    const data = await res.json();
    setAccounts(data.accounts || []);
  }

  async function loadMappings() {
    const res = await fetch(`/api/v1/integrations/xero/mappings?platform=${SHARED_PLATFORM}`);
    if (!res.ok) return;
    const data = await res.json();
    setMappings(data.mappings as Mapping[]);
  }

  useEffect(() => {
    Promise.all([loadAccounts(), loadMappings()]).finally(() => setLoading(false));
  }, []);

  function updateLocal(category: string, code: string | null) {
    setMappings((current) => {
      if (!current) return current;
      const account = accounts?.find((a) => a.code === code) || null;
      return current.map((m) =>
        m.category === category
          ? { ...m, xeroAccountCode: code, xeroAccountName: account?.name ?? null }
          : m,
      );
    });
  }

  function applySuggestedDefaults() {
    setMappings((current) => {
      if (!current) return current;
      let filled = 0;
      const updated = current.map((m) => {
        if (m.xeroAccountCode || !m.defaultAccountCode) return m;
        const account = accounts?.find((a) => a.code === m.defaultAccountCode);
        if (!account) return m;
        filled++;
        return { ...m, xeroAccountCode: account.code, xeroAccountName: account.name };
      });
      if (filled === 0) toast.info("Suggested codes already mapped or not in your Xero chart.");
      else toast.success(`Filled ${filled} row${filled === 1 ? "" : "s"} with suggested defaults.`);
      return updated;
    });
  }

  async function save() {
    if (!mappings) return;
    setSaving(true);
    try {
      const res = await fetch("/api/v1/integrations/xero/mappings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          platform: SHARED_PLATFORM,
          mappings: mappings.map((m) => ({
            category: m.category,
            xeroAccountCode: m.xeroAccountCode,
            xeroAccountName: m.xeroAccountName,
            notes: m.notes,
          })),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to save");
      toast.success(`Saved ${data.upserted} shared mapping${data.upserted === 1 ? "" : "s"}.`);
      await loadMappings();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <Card>
        <CardContent className="pt-6 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 inline animate-spin mr-2" />Loading shared mappings...</CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Shared accounts (COGS + Inventory)</CardTitle>
        <CardDescription>
          Used by every channel. The Sales Channel tracking option still tags every line so your P&amp;L splits per-channel gross profit automatically.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-[40%]">Category</TableHead>
              <TableHead>Xero account</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {(mappings || []).map((m) => (
              <TableRow key={m.category}>
                <TableCell>
                  <div className="font-medium flex items-center gap-2">
                    {m.label}
                    <Badge variant="outline" className="text-[10px] uppercase font-normal">{m.side}</Badge>
                  </div>
                  <div className="text-xs text-muted-foreground">{m.hint}</div>
                  {m.defaultAccountCode && !m.xeroAccountCode && (
                    <div className="text-[11px] text-muted-foreground mt-1">
                      Suggested:{" "}
                      <span className="font-mono">{m.defaultAccountCode}</span>{" "}
                      <span>{m.defaultAccountName}</span>
                    </div>
                  )}
                </TableCell>
                <TableCell>
                  <AccountCombobox
                    accounts={accounts || []}
                    value={m.xeroAccountCode}
                    onChange={(code) => updateLocal(m.category, code)}
                  />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        <div className="mt-3 flex justify-between items-center">
          <Button variant="outline" onClick={applySuggestedDefaults} disabled={saving}>
            <Sparkles className="h-4 w-4 mr-2" />
            Apply suggested defaults
          </Button>
          <Button onClick={save} disabled={saving}>
            <Save className="h-4 w-4 mr-2" />
            Save shared mappings
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

// Local copy of the searchable combobox — keeps this component self-contained.
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
          <Button variant="outline" className="w-full justify-between font-normal min-w-[400px]" type="button">
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
        <Command filter={(itemValue, search) => itemValue.toLowerCase().includes(search.toLowerCase()) ? 1 : 0}>
          <CommandInput placeholder="Search by code, name, or type..." />
          <CommandList>
            <CommandEmpty>No accounts match.</CommandEmpty>
            <CommandGroup>
              {value && (
                <CommandItem value="__clear__ Not mapped" onSelect={() => { onChange(null); setOpen(false); }} className="text-muted-foreground">
                  <X className="mr-2 h-4 w-4" />Clear mapping
                </CommandItem>
              )}
              {accounts.map((a) => {
                const isSelected = a.code === value;
                return (
                  <CommandItem
                    key={a.code}
                    value={`${a.code} ${a.name} ${a.type}`}
                    onSelect={() => { onChange(a.code); setOpen(false); }}
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
