"use client";

import { useEffect, useState, useCallback } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import {
  ArrowLeft, Save, Edit2, Check, X, Package, Tag, FileText,
  Image as ImageIcon, Eye, ChevronRight, ExternalLink as ExternalLinkIcon,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Progress } from "@/components/ui/progress";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { FACTORY_MAP } from "@/modules/catalog/schema";
import { ImageManagementTab } from "@/modules/catalog/components/image-management-tab";
import { CopyManagementTab } from "@/modules/catalog/components/copy-management-tab";
import { TagManagementTab } from "@/modules/catalog/components/tag-management-tab";
import { KeywordsTab } from "@/modules/catalog/components/keywords-tab";
import { MetafieldsTab } from "@/modules/catalog/components/metafields-tab";

type Product = {
  id: string;
  skuPrefix: string | null;
  name: string | null;
  description: string | null;
  shortDescription: string | null;
  bulletPoints: string | null;
  category: string | null;
  frameShape: string | null;
  frameMaterial: string | null;
  gender: string | null;
  lensType: string | null;
  wholesalePrice: number | null;
  retailPrice: number | null;
  msrp: number | null;
  factoryName: string | null;
  factorySku: string | null;
  seoTitle: string | null;
  metaDescription: string | null;
  status: string | null;
  aiCategorization: string | null;
  aiCategorizedAt: string | null;
  aiCategorizationModel: string | null;
};

type Sku = {
  id: string;
  sku: string | null;
  colorName: string | null;
  colorHex: string | null;
  size: string | null;
  upc: string | null;
  costPrice: number | null;
  wholesalePrice: number | null;
  retailPrice: number | null;
  inStock: boolean | null;
  status: string | null;
};

type TagItem = { id: string; tagName: string | null; dimension: string | null; source: string | null };
type ImageStat = { skuId: string; total: number; approved: number };

const STATUS_COLORS: Record<string, string> = {
  intake: "bg-gray-100 text-gray-700",
  processing: "bg-blue-100 text-blue-700",
  review: "bg-yellow-100 text-yellow-700",
  approved: "bg-green-100 text-green-700",
  published: "bg-purple-100 text-purple-700",
};

const STATUS_PIPELINE = ["intake", "processing", "review", "approved", "published"];

function computeCompleteness(product: Product, skuCount: number, hasImages: boolean, hasTags: boolean): number {
  let score = 0;
  if (product.name) score++;
  if (product.description) score++;
  if (product.retailPrice) score++;
  if (product.wholesalePrice) score++;
  if (product.category) score++;
  if (skuCount > 0) score++;
  if (hasImages) score++;
  if (hasTags) score++;
  return Math.round((score / 8) * 100);
}

export default function ProductDetailPage() {
  const params = useParams();
  const skuPrefix = params.sku as string;
  const [product, setProduct] = useState<Product | null>(null);
  const [skusList, setSkusList] = useState<Sku[]>([]);
  const [tagsList, setTagsList] = useState<TagItem[]>([]);
  const [imageStats, setImageStats] = useState<ImageStat[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [editData, setEditData] = useState<Partial<Product>>({});
  const [editingSku, setEditingSku] = useState<string | null>(null);
  const [skuEditData, setSkuEditData] = useState<Partial<Sku>>({});
  const [saving, setSaving] = useState(false);
  const [productId, setProductId] = useState<string | null>(null);

  const loadProduct = useCallback(async () => {
    try {
      const searchRes = await fetch(`/api/v1/catalog/products?search=${encodeURIComponent(skuPrefix)}`);
      const searchData = await searchRes.json();
      const match = searchData.products?.find((p: { skuPrefix: string }) => p.skuPrefix === skuPrefix);
      if (!match) { setLoading(false); return; }

      setProductId(match.id);
      const detailRes = await fetch(`/api/v1/catalog/products/${match.id}`);
      const data = await detailRes.json();
      setProduct(data.product);
      setSkusList(data.skus || []);
      setTagsList(data.tags || []);
      setImageStats(data.imageStats || []);
      setLoading(false);
    } catch {
      setLoading(false);
    }
  }, [skuPrefix]);

  useEffect(() => { loadProduct(); }, [loadProduct]);

  const saveProduct = async () => {
    if (!productId) return;
    setSaving(true);
    await fetch(`/api/v1/catalog/products/${productId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(editData),
    });
    setEditing(false);
    setSaving(false);
    await loadProduct();
  };

  const updateStatus = async (status: string) => {
    if (!productId) return;
    await fetch(`/api/v1/catalog/products/${productId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    });
    await loadProduct();
  };

  const saveSku = async (skuId: string) => {
    setSaving(true);
    await fetch(`/api/v1/catalog/skus/${skuId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(skuEditData),
    });
    setEditingSku(null);
    setSaving(false);
    await loadProduct();
  };

  if (loading) return (
    <div className="p-6">
      <div className="animate-pulse space-y-4">
        <div className="h-8 w-48 bg-muted rounded" />
        <div className="h-64 bg-muted rounded-lg" />
      </div>
    </div>
  );
  if (!product) return (
    <div className="p-6 text-center py-16">
      <Package className="h-10 w-10 mx-auto text-muted-foreground/50 mb-3" />
      <p className="font-medium text-muted-foreground">Product not found</p>
      <Link href="/catalog" className="mt-4 inline-flex items-center gap-2 text-sm text-primary hover:underline">
        <ArrowLeft className="h-4 w-4" /> Back to Catalog
      </Link>
    </div>
  );

  const totalImages = imageStats.reduce((s, i) => s + i.total, 0);
  const approvedImages = imageStats.reduce((s, i) => s + i.approved, 0);
  const completeness = computeCompleteness(product, skusList.length, approvedImages > 0, tagsList.length > 0);
  const currentStatusIdx = STATUS_PIPELINE.indexOf(product.status || "intake");

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center gap-4">
        <Link href="/catalog" className="text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-5 w-5" />
        </Link>
        <div className="flex-1">
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-bold">{product.name || product.skuPrefix}</h1>
            <Badge variant="secondary" className={STATUS_COLORS[product.status || "intake"]}>{product.status}</Badge>
            <div className="flex items-center gap-1 text-sm text-muted-foreground">
              <Progress value={completeness} className="h-2 w-20" />
              <span>{completeness}%</span>
            </div>
          </div>
          <p className="text-muted-foreground font-mono">{product.skuPrefix}</p>
        </div>
        {productId && <ExternalLinksRow productId={productId} />}
      </div>

      {/* Status Pipeline */}
      <div className="flex items-center gap-1">
        {STATUS_PIPELINE.map((s, i) => (
          <div key={s} className="flex items-center">
            <button
              onClick={() => updateStatus(s)}
              className={`px-3 py-1 rounded-full text-xs font-medium transition-colors ${
                i <= currentStatusIdx
                  ? "bg-primary text-primary-foreground"
                  : "bg-muted text-muted-foreground hover:bg-muted/80"
              }`}
            >
              {s}
            </button>
            {i < STATUS_PIPELINE.length - 1 && <ChevronRight className="h-3 w-3 text-muted-foreground mx-1" />}
          </div>
        ))}
      </div>

      {/* Tabs */}
      <Tabs defaultValue="overview">
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="skus">SKUs ({skusList.length})</TabsTrigger>
          <TabsTrigger value="images">Images ({totalImages})</TabsTrigger>
          <TabsTrigger value="copy">Copy</TabsTrigger>
          <TabsTrigger value="tags">Tags ({tagsList.length})</TabsTrigger>
          <TabsTrigger value="keywords">Keywords</TabsTrigger>
          <TabsTrigger value="metafields">Metafields</TabsTrigger>
          <TabsTrigger value="export">Export Preview</TabsTrigger>
        </TabsList>

        {/* Overview Tab */}
        <TabsContent value="overview" className="space-y-4">
          <div className="flex justify-end">
            {editing ? (
              <div className="flex gap-2">
                <Button size="sm" variant="outline" onClick={() => setEditing(false)}><X className="h-3 w-3 mr-1" /> Cancel</Button>
                <Button size="sm" onClick={saveProduct} disabled={saving}><Save className="h-3 w-3 mr-1" /> Save</Button>
              </div>
            ) : (
              <Button size="sm" variant="outline" onClick={() => { setEditing(true); setEditData({ ...product }); }}>
                <Edit2 className="h-3 w-3 mr-1" /> Edit
              </Button>
            )}
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Card>
              <CardHeader><CardTitle className="text-sm">Product Details</CardTitle></CardHeader>
              <CardContent className="space-y-3">
                {editing ? (
                  <>
                    <Field label="Name" value={editData.name || ""} onChange={(v) => setEditData({ ...editData, name: v })} />
                    {/* Category, frame shape, material, gender, lens type are
                        derived from catalog tags. Edit them on the Tags tab. */}
                    <Row label="Category" value={product.category} hint="edit on Tags tab" />
                    <Row label="Frame Shape" value={product.frameShape} hint="edit on Tags tab" />
                    <Row label="Frame Material" value={product.frameMaterial} hint="edit on Tags tab" />
                    <Row label="Gender" value={product.gender} hint="edit on Tags tab" />
                    <Row label="Lens Type" value={product.lensType} hint="edit on Tags tab" />
                    <Field label="Factory" value={editData.factoryName || ""} onChange={(v) => setEditData({ ...editData, factoryName: v })} />
                    <Field label="Factory SKU" value={editData.factorySku || ""} onChange={(v) => setEditData({ ...editData, factorySku: v })} />
                  </>
                ) : (
                  <>
                    <Row label="Category" value={product.category} />
                    <Row label="Frame Shape" value={product.frameShape} />
                    <Row label="Frame Material" value={product.frameMaterial} />
                    <Row label="Gender" value={product.gender} />
                    <Row label="Lens Type" value={product.lensType} />
                    <Row label="Factory" value={product.factoryName} />
                    <Row label="Factory SKU" value={product.factorySku} />
                  </>
                )}
              </CardContent>
            </Card>
            <Card>
              <CardHeader><CardTitle className="text-sm">Pricing</CardTitle></CardHeader>
              <CardContent className="space-y-3">
                {editing ? (
                  <>
                    <Field label="Wholesale" value={String(editData.wholesalePrice || "")} onChange={(v) => setEditData({ ...editData, wholesalePrice: Number(v) || null })} type="number" />
                    <Field label="Retail" value={String(editData.retailPrice || "")} onChange={(v) => setEditData({ ...editData, retailPrice: Number(v) || null })} type="number" />
                    <Field label="MSRP" value={String(editData.msrp || "")} onChange={(v) => setEditData({ ...editData, msrp: Number(v) || null })} type="number" />
                  </>
                ) : (
                  <>
                    <Row label="Wholesale" value={product.wholesalePrice ? `$${product.wholesalePrice.toFixed(2)}` : null} />
                    <Row label="Retail" value={product.retailPrice ? `$${product.retailPrice.toFixed(2)}` : null} />
                    <Row label="MSRP" value={product.msrp ? `$${product.msrp.toFixed(2)}` : null} />
                  </>
                )}
              </CardContent>
            </Card>
          </div>

          {editing ? (
            <Card>
              <CardHeader><CardTitle className="text-sm">Description</CardTitle></CardHeader>
              <CardContent>
                <Textarea
                  value={editData.description || ""}
                  onChange={(e) => setEditData({ ...editData, description: e.target.value })}
                  rows={4}
                />
              </CardContent>
            </Card>
          ) : product.description ? (
            <Card>
              <CardHeader><CardTitle className="text-sm">Description</CardTitle></CardHeader>
              <CardContent className="text-sm">{product.description}</CardContent>
            </Card>
          ) : null}

          {productId && (
            <SeoCard
              productId={productId}
              skuPrefix={product.skuPrefix}
              initialTitle={product.seoTitle ?? ""}
              initialDescription={product.metaDescription ?? ""}
              onSaved={loadProduct}
            />
          )}
        </TabsContent>

        {/* SKUs Tab */}
        <TabsContent value="skus">
          <Card>
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>SKU</TableHead>
                    <TableHead>Frame Color</TableHead>
                    <TableHead>Size</TableHead>
                    <TableHead>UPC</TableHead>
                    <TableHead className="text-right">Cost</TableHead>
                    <TableHead className="text-right">Wholesale</TableHead>
                    <TableHead className="text-right">Retail</TableHead>
                    <TableHead>In Stock</TableHead>
                    <TableHead>Images</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="w-20"></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {skusList.map((sku) => {
                    const isEditing = editingSku === sku.id;
                    const imgStat = imageStats.find((s) => s.skuId === sku.id);
                    return (
                      <TableRow key={sku.id}>
                        <TableCell className="font-mono text-sm">{sku.sku}</TableCell>
                        <TableCell>
                          {isEditing ? (
                            <div className="flex items-center gap-1">
                              <input type="color" value={skuEditData.colorHex || "#000"} onChange={(e) => setSkuEditData({ ...skuEditData, colorHex: e.target.value })} className="w-6 h-6" />
                              <Input value={skuEditData.colorName || ""} onChange={(e) => setSkuEditData({ ...skuEditData, colorName: e.target.value })} className="w-24 h-7 text-xs" />
                            </div>
                          ) : (
                            <div className="flex items-center gap-2">
                              {sku.colorHex && <div className="w-4 h-4 rounded-full border" style={{ backgroundColor: sku.colorHex }} />}
                              {sku.colorName}
                            </div>
                          )}
                        </TableCell>
                        <TableCell>
                          {isEditing ? <Input value={skuEditData.size || ""} onChange={(e) => setSkuEditData({ ...skuEditData, size: e.target.value })} className="w-16 h-7 text-xs" /> : sku.size}
                        </TableCell>
                        <TableCell className="font-mono text-xs">
                          {isEditing ? <Input value={skuEditData.upc || ""} onChange={(e) => setSkuEditData({ ...skuEditData, upc: e.target.value })} className="w-32 h-7 text-xs" /> : sku.upc}
                        </TableCell>
                        <TableCell className="text-right">
                          {isEditing ? <Input type="number" value={skuEditData.costPrice ?? ""} onChange={(e) => setSkuEditData({ ...skuEditData, costPrice: Number(e.target.value) || null })} className="w-20 h-7 text-xs" /> : (sku.costPrice ? `$${sku.costPrice.toFixed(2)}` : "—")}
                        </TableCell>
                        <TableCell className="text-right">
                          {isEditing ? <Input type="number" value={skuEditData.wholesalePrice ?? ""} onChange={(e) => setSkuEditData({ ...skuEditData, wholesalePrice: Number(e.target.value) || null })} className="w-20 h-7 text-xs" /> : (sku.wholesalePrice ? `$${sku.wholesalePrice.toFixed(2)}` : "—")}
                        </TableCell>
                        <TableCell className="text-right">
                          {isEditing ? <Input type="number" value={skuEditData.retailPrice ?? ""} onChange={(e) => setSkuEditData({ ...skuEditData, retailPrice: Number(e.target.value) || null })} className="w-20 h-7 text-xs" /> : (sku.retailPrice ? `$${sku.retailPrice.toFixed(2)}` : "—")}
                        </TableCell>
                        <TableCell>
                          <Badge variant={sku.inStock ? "default" : "secondary"}>{sku.inStock ? "Yes" : "No"}</Badge>
                        </TableCell>
                        <TableCell>
                          <span className="text-xs">{imgStat?.approved || 0}/{imgStat?.total || 0}</span>
                        </TableCell>
                        <TableCell>
                          <Badge variant="secondary" className={STATUS_COLORS[sku.status || "intake"]}>{sku.status}</Badge>
                        </TableCell>
                        <TableCell>
                          {isEditing ? (
                            <div className="flex gap-1">
                              <Button size="icon" variant="ghost" className="h-6 w-6" onClick={() => saveSku(sku.id)} disabled={saving}><Check className="h-3 w-3" /></Button>
                              <Button size="icon" variant="ghost" className="h-6 w-6" onClick={() => setEditingSku(null)}><X className="h-3 w-3" /></Button>
                            </div>
                          ) : (
                            <Button size="icon" variant="ghost" className="h-6 w-6" onClick={() => { setEditingSku(sku.id); setSkuEditData({ ...sku }); }}>
                              <Edit2 className="h-3 w-3" />
                            </Button>
                          )}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>

        {/* Images Tab */}
        <TabsContent value="images">
          <ImageManagementTab productId={productId!} skus={skusList} onRefresh={loadProduct} />
        </TabsContent>

        {/* Copy Tab */}
        <TabsContent value="copy">
          <CopyManagementTab productId={productId!} product={product} onRefresh={loadProduct} />
        </TabsContent>

        {/* Tags Tab */}
        <TabsContent value="tags">
          <TagManagementTab productId={productId!} tags={tagsList} onRefresh={loadProduct} productName={product?.name} skuPrefix={product?.skuPrefix} />
        </TabsContent>

        {/* Keywords Tab */}
        <TabsContent value="keywords">
          <KeywordsTab productId={productId!} />
        </TabsContent>

        {/* Export Preview Tab */}
        <TabsContent value="metafields">
          {productId && product && (
            <MetafieldsTab
              productId={productId}
              aiCategorization={product.aiCategorization}
              aiCategorizedAt={product.aiCategorizedAt}
              aiCategorizationModel={product.aiCategorizationModel}
              onRefresh={loadProduct}
            />
          )}
        </TabsContent>

        <TabsContent value="export">
          <Card>
            <CardContent className="p-6">
              <div className="text-center text-muted-foreground space-y-2">
                <Eye className="h-12 w-12 mx-auto opacity-50" />
                <p>Export preview — see how this product will appear on Shopify, Faire, Amazon.</p>
                <Link href="/catalog/export">
                  <Button variant="outline" size="sm" className="mt-2">Go to Export</Button>
                </Link>
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}

function Row({ label, value, hint }: { label: string; value: string | null | undefined; hint?: string }) {
  return (
    <div className="flex justify-between text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-right">
        <span>{value || "—"}</span>
        {hint && <span className="block text-[10px] text-muted-foreground">{hint}</span>}
      </span>
    </div>
  );
}

function Field({ label, value, onChange, type = "text" }: { label: string; value: string; onChange: (v: string) => void; type?: string }) {
  return (
    <div className="space-y-1">
      <Label className="text-xs">{label}</Label>
      <Input type={type} value={value} onChange={(e) => onChange(e.target.value)} className="h-8" />
    </div>
  );
}

/**
 * Always-visible SEO editor on the Overview tab.
 * Edit-in-place; "Regenerate with AI" calls the AI prompt; "Save"
 * persists to the-frame DB AND pushes to retail Shopify (Simprosys
 * picks it up for the Google Shopping feed).
 */
function SeoCard({
  productId,
  skuPrefix,
  initialTitle,
  initialDescription,
  onSaved,
}: {
  productId: string;
  skuPrefix: string | null;
  initialTitle: string;
  initialDescription: string;
  onSaved: () => void;
}) {
  const [title, setTitle] = useState(initialTitle);
  const [description, setDescription] = useState(initialDescription);
  const [generating, setGenerating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Sync if upstream value changes (e.g. after a regenerate/save)
  useEffect(() => { setTitle(initialTitle); }, [initialTitle]);
  useEffect(() => { setDescription(initialDescription); }, [initialDescription]);

  const dirty = title !== initialTitle || description !== initialDescription;

  const handleRegenerate = async () => {
    setGenerating(true);
    setErrorMsg(null);
    setStatusMsg(null);
    try {
      const res = await fetch(`/api/v1/catalog/products/${productId}/generate-seo`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const data = await res.json();
      if (!res.ok) {
        setErrorMsg(data.error || `HTTP ${res.status}`);
      } else {
        setTitle(data.generated.title);
        setDescription(data.generated.description);
        setStatusMsg(`Regenerated by ${data.model}. Review and Save to push to retail.`);
      }
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "unknown");
    }
    setGenerating(false);
  };

  const handleSave = async () => {
    setSaving(true);
    setErrorMsg(null);
    setStatusMsg(null);
    try {
      const res = await fetch(`/api/v1/catalog/products/${productId}/save-seo`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, description }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setErrorMsg(data.shopifyRetail?.error || data.error || `HTTP ${res.status}`);
      } else {
        setStatusMsg(
          data.shopifyRetail.productId
            ? `Saved + pushed to retail Shopify (product ${data.shopifyRetail.productId})`
            : `Saved`,
        );
        onSaved();
      }
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "unknown");
    }
    setSaving(false);
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm flex items-center justify-between">
          <span>Google Shopping SEO {skuPrefix && <span className="text-xs text-muted-foreground font-normal">· {skuPrefix}</span>}</span>
          <div className="flex gap-2">
            <Button size="sm" variant="outline" onClick={handleRegenerate} disabled={generating || saving}>
              {generating ? "Regenerating…" : "Regenerate with AI"}
            </Button>
            <Button size="sm" onClick={handleSave} disabled={saving || !dirty || !title.trim() || !description.trim()}>
              {saving ? "Saving…" : dirty ? "Save & push to retail" : "Saved"}
            </Button>
          </div>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-xs text-muted-foreground">
          These two fields drive the Shopify storefront SEO and the
          Simprosys Google Shopping feed (retail only). Edit freely; AI
          regeneration uses your tags + curated keywords. Saving pushes
          to retail Shopify on the spot.
        </p>

        <div className="space-y-1">
          <Label className="text-xs flex items-center justify-between">
            <span>Title</span>
            <span className={`font-mono ${title.length > 130 || title.length < 50 ? "text-amber-700" : "text-muted-foreground"}`}>
              {title.length} / target 70–90
            </span>
          </Label>
          <Textarea
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            rows={2}
            className="text-sm"
            placeholder="e.g. Monroe Cat-Eye Polarized Sunglasses for Women — Vintage Black, Tortoise & White by Jaxy"
          />
        </div>

        <div className="space-y-1">
          <Label className="text-xs flex items-center justify-between">
            <span>Meta description</span>
            <span className={`font-mono ${description.length > 900 || description.length < 400 ? "text-amber-700" : "text-muted-foreground"}`}>
              {description.length} / target 600
            </span>
          </Label>
          <Textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={6}
            className="text-sm"
            placeholder="Lead with shape and lens type — these first 160 characters are the mobile preview."
          />
        </div>

        {statusMsg && <div className="text-xs text-green-700">{statusMsg}</div>}
        {errorMsg && <div className="text-xs text-red-600">{errorMsg}</div>}
      </CardContent>
    </Card>
  );
}

/** Quick-jump links to this product on each external sales channel. */
type ExternalLinkRow = {
  channel: "shopify_retail" | "shopify_wholesale" | "faire" | "amazon" | "tiktok_shop";
  label: string;
  available: boolean;
  url: string | null;
  reason?: string;
};

function ExternalLinksRow({ productId }: { productId: string }) {
  const [links, setLinks] = useState<ExternalLinkRow[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/v1/catalog/products/${productId}/external-links`)
      .then((r) => r.json())
      .then((d) => {
        if (!cancelled) setLinks(d.links || []);
      })
      .catch(() => {
        if (!cancelled) setLinks([]);
      });
    return () => { cancelled = true; };
  }, [productId]);

  // Always render the row (even while loading) so the page doesn't reflow
  if (!links) return null;

  return (
    <div className="flex flex-wrap items-center gap-2">
      {links.map((link) => {
        // Disabled state: not connected / integration not built
        if (!link.available || !link.url) {
          return (
            <Button
              key={link.channel}
              size="sm"
              variant="outline"
              disabled
              title={link.reason}
              className="opacity-50"
            >
              <ExternalLinkIcon className="h-3 w-3 mr-1" />
              {link.label}
            </Button>
          );
        }
        return (
          <a key={link.channel} href={link.url} target="_blank" rel="noopener noreferrer">
            <Button size="sm" variant="outline" title={link.reason}>
              <ExternalLinkIcon className="h-3 w-3 mr-1" />
              {link.label}
            </Button>
          </a>
        );
      })}
    </div>
  );
}
