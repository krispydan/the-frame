"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Layers3, Target, DollarSign, Users, ChevronRight } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

interface Segment {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  status: "active" | "paused" | "retired";
  prospect_count: number;
  qualified_count: number;
  customer_count: number;
  active_deals: number;
  pipeline_value: number;
  order_count: number;
  revenue: number;
  campaign_count: number;
}

interface SegmentsResponse {
  data: Segment[];
  summary: {
    segments: number;
    prospects: number;
    qualified: number;
    pipelineValue: number;
    revenue: number;
  };
}

const statusTone: Record<Segment["status"], string> = {
  active: "bg-green-100 text-green-800",
  paused: "bg-yellow-100 text-yellow-800",
  retired: "bg-gray-100 text-gray-700",
};

export default function SegmentsPage() {
  const [payload, setPayload] = useState<SegmentsResponse | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/v1/sales/segments")
      .then((r) => r.json())
      .then((data) => setPayload(data))
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return <div className="p-6 text-muted-foreground">Loading segments...</div>;
  }

  const segments = payload?.data || [];
  const summary = payload?.summary || {
    segments: 0,
    prospects: 0,
    qualified: 0,
    pipelineValue: 0,
    revenue: 0,
  };

  return (
    <div className="space-y-6 p-4 md:p-6 max-w-full xl:max-w-[1200px] mx-auto">
      <div className="flex items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Segments</h1>
          <p className="text-sm text-muted-foreground">
            First-class ICP buckets across prospects, deals, campaigns, and revenue.
          </p>
        </div>
        <Badge variant="secondary" className="px-3 py-1 text-xs">
          {summary.segments} live segments
        </Badge>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
        <SummaryCard title="Segments" value={summary.segments.toLocaleString()} icon={<Layers3 className="w-4 h-4" />} />
        <SummaryCard title="Prospects" value={summary.prospects.toLocaleString()} icon={<Users className="w-4 h-4" />} />
        <SummaryCard title="Pipeline" value={`$${summary.pipelineValue.toLocaleString()}`} icon={<Target className="w-4 h-4" />} />
        <SummaryCard title="Revenue" value={`$${summary.revenue.toLocaleString()}`} icon={<DollarSign className="w-4 h-4" />} />
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Segment Scoreboard</CardTitle>
        </CardHeader>
        <CardContent>
          {segments.length === 0 ? (
            <div className="text-sm text-muted-foreground">No structured segments yet.</div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Segment</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Prospects</TableHead>
                  <TableHead className="text-right">Qualified</TableHead>
                  <TableHead className="text-right">Customers</TableHead>
                  <TableHead className="text-right">Deals</TableHead>
                  <TableHead className="text-right">Campaigns</TableHead>
                  <TableHead className="text-right">Revenue</TableHead>
                  <TableHead className="text-right">Explore</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {segments.map((segment) => (
                  <TableRow key={segment.id}>
                    <TableCell>
                      <div className="space-y-1">
                        <div className="font-medium text-gray-900 dark:text-white">{segment.name}</div>
                        <div className="text-xs text-muted-foreground">
                          {segment.description || "No ICP profile written yet."}
                        </div>
                      </div>
                    </TableCell>
                    <TableCell>
                      <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${statusTone[segment.status]}`}>
                        {segment.status}
                      </span>
                    </TableCell>
                    <TableCell className="text-right">{segment.prospect_count.toLocaleString()}</TableCell>
                    <TableCell className="text-right">{segment.qualified_count.toLocaleString()}</TableCell>
                    <TableCell className="text-right">{segment.customer_count.toLocaleString()}</TableCell>
                    <TableCell className="text-right">
                      <div>{segment.active_deals.toLocaleString()}</div>
                      <div className="text-xs text-muted-foreground">${segment.pipeline_value.toLocaleString()}</div>
                    </TableCell>
                    <TableCell className="text-right">{segment.campaign_count.toLocaleString()}</TableCell>
                    <TableCell className="text-right">${segment.revenue.toLocaleString()}</TableCell>
                    <TableCell className="text-right">
                      <Link
                        href={`/prospects?segment=${encodeURIComponent(segment.name)}`}
                        className="inline-flex items-center gap-1 text-sm text-blue-600 hover:text-blue-700"
                      >
                        Prospects <ChevronRight className="w-3 h-3" />
                      </Link>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function SummaryCard({ title, value, icon }: { title: string; value: string; icon: React.ReactNode }) {
  return (
    <Card>
      <CardContent className="pt-6">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm text-muted-foreground">{title}</p>
            <p className="text-2xl font-semibold mt-1">{value}</p>
          </div>
          <div className="p-2 rounded-lg bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-300">
            {icon}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
