"use client";

/**
 * Client island for the Amazon keyword review page. Tabs per shape (+
 * Head + Scrubbed); each row shows the Helium metrics and a whitelist /
 * blacklist / clear control that POSTs to the override route. Override
 * state is tracked locally for instant feedback.
 */

import { useState } from "react";
import {
  Tabs, TabsContent, TabsList, TabsTrigger,
} from "@/components/ui/tabs";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Check, Ban, RotateCcw } from "lucide-react";
import { toast } from "sonner";

export interface KeywordRow {
  phrase: string;
  searchVolume: number;
  titleDensity: number;
  pool: string | null;
  shape: string | null;
  verdict: string;
  overrideStatus: string | null;
}

type Override = "whitelist" | "blacklist" | "clear";

const SHAPE_ORDER = ["head", "round", "cat-eye", "square", "aviator", "oval", "rectangle", "hexagon"];
const SHAPE_LABEL: Record<string, string> = {
  head: "Head (shared)", "round": "Round", "cat-eye": "Cat-Eye", square: "Square",
  aviator: "Aviator", oval: "Oval", rectangle: "Rectangle", hexagon: "Hexagon",
};

export function KeywordsTable({
  buckets, scrubbed,
}: {
  buckets: Record<string, KeywordRow[]>;
  scrubbed: KeywordRow[];
}) {
  // phrase → current override status (local mirror of the server).
  const [overrides, setOverrides] = useState<Record<string, string | null>>(() => {
    const seed: Record<string, string | null> = {};
    for (const list of [...Object.values(buckets), scrubbed]) {
      for (const r of list) if (r.overrideStatus) seed[r.phrase] = r.overrideStatus;
    }
    return seed;
  });
  const [pending, setPending] = useState<Record<string, boolean>>({});

  async function setOverride(phrase: string, status: Override) {
    setPending((p) => ({ ...p, [phrase]: true }));
    try {
      const res = await fetch("/api/v1/catalog/keywords/override", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ phrase, status }),
      });
      const json = await res.json();
      if (!json.ok) throw new Error(json.error ?? "override failed");
      setOverrides((o) => ({ ...o, [phrase]: status === "clear" ? null : status }));
      toast.success(
        status === "clear" ? `Cleared override on "${phrase}"`
          : status === "whitelist" ? `Whitelisted "${phrase}"`
            : `Blacklisted "${phrase}"`,
      );
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "override failed");
    } finally {
      setPending((p) => ({ ...p, [phrase]: false }));
    }
  }

  const tabs = SHAPE_ORDER
    .filter((s) => buckets[s]?.length)
    .map((s) => ({ key: s, label: SHAPE_LABEL[s] ?? s, rows: buckets[s] }));
  tabs.push({ key: "__scrubbed", label: "Scrubbed", rows: scrubbed });

  const first = tabs[0]?.key ?? "head";

  return (
    <Tabs defaultValue={first} className="space-y-4">
      <TabsList className="flex-wrap h-auto">
        {tabs.map((t) => (
          <TabsTrigger key={t.key} value={t.key} className="gap-1.5">
            {t.label}
            <span className="text-xs text-muted-foreground">{t.rows.length}</span>
          </TabsTrigger>
        ))}
      </TabsList>

      {tabs.map((t) => (
        <TabsContent key={t.key} value={t.key}>
          <KeywordRows
            rows={t.rows}
            scrubbedTab={t.key === "__scrubbed"}
            overrides={overrides}
            pending={pending}
            onSet={setOverride}
          />
        </TabsContent>
      ))}
    </Tabs>
  );
}

function KeywordRows({
  rows, scrubbedTab, overrides, pending, onSet,
}: {
  rows: KeywordRow[];
  scrubbedTab: boolean;
  overrides: Record<string, string | null>;
  pending: Record<string, boolean>;
  onSet: (phrase: string, status: Override) => void;
}) {
  if (rows.length === 0) {
    return <p className="text-sm text-muted-foreground py-8 text-center">No keywords in this bucket yet — import a Cerebro export.</p>;
  }
  return (
    <div className="rounded-md border max-h-[600px] overflow-y-auto">
      <Table>
        <TableHeader className="sticky top-0 bg-background z-10">
          <TableRow>
            <TableHead>Keyword</TableHead>
            <TableHead className="text-right w-28">Volume</TableHead>
            <TableHead className="text-right w-28">Title density</TableHead>
            <TableHead className="w-28">{scrubbedTab ? "Reason" : "Pool"}</TableHead>
            <TableHead className="w-44 text-right">Override</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r) => {
            const status = overrides[r.phrase] ?? null;
            const isPending = !!pending[r.phrase];
            return (
              <TableRow key={r.phrase} className={status === "blacklist" ? "opacity-50" : ""}>
                <TableCell className="font-medium">
                  {r.phrase}
                  {status === "whitelist" && <Badge variant="secondary" className="ml-2">whitelisted</Badge>}
                  {status === "blacklist" && <Badge variant="destructive" className="ml-2">blocked</Badge>}
                </TableCell>
                <TableCell className="text-right tabular-nums">{r.searchVolume.toLocaleString()}</TableCell>
                <TableCell className="text-right tabular-nums">{r.titleDensity.toLocaleString()}</TableCell>
                <TableCell>
                  <Badge variant="outline" className="capitalize">
                    {scrubbedTab ? r.verdict : (r.pool ?? "head")}
                  </Badge>
                </TableCell>
                <TableCell className="text-right">
                  <div className="flex gap-1 justify-end">
                    {scrubbedTab ? (
                      // Scrubbed rows: let an operator rescue one (whitelist).
                      status === "whitelist" ? (
                        <Button size="sm" variant="ghost" disabled={isPending} onClick={() => onSet(r.phrase, "clear")}>
                          <RotateCcw className="h-3.5 w-3.5" /> Undo
                        </Button>
                      ) : (
                        <Button size="sm" variant="outline" disabled={isPending} onClick={() => onSet(r.phrase, "whitelist")}>
                          <Check className="h-3.5 w-3.5" /> Keep anyway
                        </Button>
                      )
                    ) : status ? (
                      <Button size="sm" variant="ghost" disabled={isPending} onClick={() => onSet(r.phrase, "clear")}>
                        <RotateCcw className="h-3.5 w-3.5" /> Clear
                      </Button>
                    ) : (
                      <Button size="sm" variant="ghost" disabled={isPending} onClick={() => onSet(r.phrase, "blacklist")}>
                        <Ban className="h-3.5 w-3.5" /> Block
                      </Button>
                    )}
                  </div>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
