import Link from "next/link";
import { Button } from "@/components/ui/button";
import { ArrowLeft, ScanSearch } from "lucide-react";
import { SkuIdentifier } from "@/modules/marketing/components/videos/sku-identifier";

/** SKU Identifier — filename matching + manual tagging vs the catalog. */
export default function SkuIdentifierPage() {
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="flex flex-1 min-w-[200px] items-center gap-2 text-2xl font-bold tracking-tight">
          <ScanSearch className="h-6 w-6" /> SKU Identifier
        </h1>
        <Button variant="outline" render={<Link href="/marketing/videos/clips" />}>
          <ArrowLeft className="h-4 w-4 mr-1" /> Clip Library
        </Button>
      </div>
      <SkuIdentifier />
    </div>
  );
}
