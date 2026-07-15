import Link from "next/link";
import { Button } from "@/components/ui/button";
import { ArrowLeft, ScanSearch } from "lucide-react";
import { SkuIdentifier } from "@/modules/marketing/components/videos/sku-identifier";

/** SKU Identifier — filename matching + manual tagging vs the catalog. */
export default function SkuIdentifierPage() {
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex-1 min-w-[260px]">
          <h1 className="text-3xl font-bold tracking-tight flex items-center gap-2">
            <ScanSearch className="h-7 w-7" /> SKU Identifier
          </h1>
          <p className="text-muted-foreground mt-1">
            Files named after a product are matched automatically. For the rest, compare the
            media against the catalog photos and click the right product — for video clips and
            product/lifestyle shoots alike.
          </p>
        </div>
        <Button variant="outline" render={<Link href="/marketing/videos/clips" />}>
          <ArrowLeft className="h-4 w-4 mr-1" /> Clip Library
        </Button>
      </div>
      <SkuIdentifier />
    </div>
  );
}
