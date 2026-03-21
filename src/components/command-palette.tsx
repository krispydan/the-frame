"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandSeparator,
} from "@/components/ui/command";
import {
  LayoutDashboard, Users, Kanban, Mail, ShoppingCart, Package, Warehouse, DollarSign, Brain, BarChart3, Settings, Bell, Search, Loader2,
} from "lucide-react";

const navCommands = [
  { label: "Go to Dashboard", icon: LayoutDashboard, path: "/dashboard" },
  { label: "Go to Prospects", icon: Users, path: "/prospects" },
  { label: "Go to Pipeline", icon: Kanban, path: "/pipeline" },
  { label: "Go to Campaigns", icon: Mail, path: "/campaigns" },
  { label: "Go to Orders", icon: ShoppingCart, path: "/orders" },
  { label: "Go to Catalog", icon: Package, path: "/catalog" },
  { label: "Go to Inventory", icon: Warehouse, path: "/inventory" },
  { label: "Go to Finance", icon: DollarSign, path: "/finance" },
  { label: "Go to AI Center", icon: Brain, path: "/ai" },
  { label: "Go to Intelligence", icon: BarChart3, path: "/intelligence" },
  { label: "Go to Notifications", icon: Bell, path: "/notifications" },
  { label: "Go to Settings", icon: Settings, path: "/settings" },
];

const actionCommands = [
  { label: "Search Prospects", icon: Search, path: "/prospects?focus=search" },
  { label: "Search Products", icon: Search, path: "/catalog?focus=search" },
  { label: "New Deal", icon: Kanban, path: "/pipeline?action=new" },
  { label: "Import Leads", icon: Users, path: "/prospects?action=import" },
];

const TYPE_ICONS: Record<string, typeof Users> = {
  prospect: Users,
  product: Package,
  deal: Kanban,
  order: ShoppingCart,
};

const TYPE_LABELS: Record<string, string> = {
  prospect: "Prospect",
  product: "Product",
  deal: "Deal",
  order: "Order",
};

interface SearchResult {
  type: "prospect" | "product" | "deal" | "order";
  id: string;
  title: string;
  subtitle: string;
  href: string;
}

export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const router = useRouter();
  const debounceRef = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.key === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setOpen(prev => !prev);
      }
    };
    document.addEventListener("keydown", down);
    return () => document.removeEventListener("keydown", down);
  }, []);

  const doSearch = useCallback(async (q: string) => {
    if (q.length < 2) {
      setResults([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const res = await fetch(`/api/v1/search?q=${encodeURIComponent(q)}&limit=10`);
      if (res.ok) {
        const data = await res.json();
        setResults(data.results ?? []);
      }
    } catch {
      // silently fail
    } finally {
      setLoading(false);
    }
  }, []);

  const onQueryChange = (value: string) => {
    setQuery(value);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => doSearch(value), 250);
  };

  // Reset on close
  useEffect(() => {
    if (!open) {
      setQuery("");
      setResults([]);
      setLoading(false);
    }
  }, [open]);

  const navigate = (path: string) => {
    router.push(path);
    setOpen(false);
  };

  const hasSearch = query.length >= 2;

  return (
    <CommandDialog open={open} onOpenChange={setOpen}>
      <CommandInput placeholder="Type a command or search..." value={query} onValueChange={onQueryChange} />
      <CommandList>
        <CommandEmpty>
          {loading ? (
            <div className="flex items-center justify-center gap-2 py-2">
              <Loader2 className="h-4 w-4 animate-spin" />
              <span>Searching…</span>
            </div>
          ) : hasSearch ? (
            "No results found."
          ) : (
            "Type to search or pick a command."
          )}
        </CommandEmpty>

        {/* Live search results */}
        {hasSearch && results.length > 0 && (
          <>
            <CommandGroup heading="Search Results">
              {results.map(r => {
                const Icon = TYPE_ICONS[r.type] || Search;
                return (
                  <CommandItem key={`${r.type}-${r.id}`} onSelect={() => navigate(r.href)}>
                    <Icon className="mr-2 h-4 w-4 shrink-0" />
                    <span className="flex-1 truncate">{r.title}</span>
                    <span className="ml-2 text-xs text-muted-foreground">{r.subtitle}</span>
                    <span className="ml-2 rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase text-muted-foreground">
                      {TYPE_LABELS[r.type]}
                    </span>
                  </CommandItem>
                );
              })}
            </CommandGroup>
            <CommandSeparator />
          </>
        )}

        {loading && hasSearch && results.length === 0 ? null : (
          <>
            <CommandGroup heading="Navigation">
              {navCommands.map(cmd => {
                const Icon = cmd.icon;
                return (
                  <CommandItem key={cmd.path} onSelect={() => navigate(cmd.path)}>
                    <Icon className="mr-2 h-4 w-4" />
                    <span>{cmd.label}</span>
                  </CommandItem>
                );
              })}
            </CommandGroup>
            <CommandSeparator />
            <CommandGroup heading="Quick Actions">
              {actionCommands.map(cmd => {
                const Icon = cmd.icon;
                return (
                  <CommandItem key={cmd.label} onSelect={() => navigate(cmd.path)}>
                    <Icon className="mr-2 h-4 w-4" />
                    <span>{cmd.label}</span>
                  </CommandItem>
                );
              })}
            </CommandGroup>
          </>
        )}
      </CommandList>
    </CommandDialog>
  );
}
