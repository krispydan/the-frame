import Link from "next/link";
import { Button } from "@/components/ui/button";
import { ArrowLeft, ScanSearch } from "lucide-react";
import { SkuIdentifier } from "@/modules/marketing/components/videos/sku-identifier";

/** AI SKU Identifier — match media against the catalog + confirm tags. */
export default function SkuIdentifierPage() {
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex-1 min-w-[260px]">
          <h1 className="text-3xl font-bold tracking-tight flex items-center gap-2">
            <ScanSearch className="h-7 w-7" /> SKU Identifier
          </h1>
          <p className="text-muted-foreground mt-1">
            AI matches your clips and images against the catalog. Review its picks (with
            confidence), click the right product, and the tags are saved to the media.
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
