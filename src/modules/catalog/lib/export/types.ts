export type ValidationSeverity = "ready" | "blocked" | "warning";

export interface ValidationIssue {
  field: string;
  message: string;
  severity: "blocked" | "warning";
}

export interface ProductValidationResult {
  productId: string;
  productName: string;
  skuPrefix: string;
  status: ValidationSeverity;
  issues: ValidationIssue[];
  skuResults: SkuValidationResult[];
}

export interface SkuValidationResult {
  skuId: string;
  sku: string;
  status: ValidationSeverity;
  issues: ValidationIssue[];
}

export interface ExportProduct {
  product: {
    id: string;
    skuPrefix: string;
    name: string | null;
    description: string | null;
    shortDescription: string | null;
    bulletPoints: string | null;
    category: string | null;
    frameShape: string | null;
    frameMaterial: string | null;
    gender: string | null;
    lensType: string | null;
  };
  skus: {
    id: string;
    sku: string | null;
    colorName: string | null;
    colorHex: string | null;
    size: string | null;
    upc: string | null;
    inStock: boolean | null;
    inventoryQuantity: number;
    costPrice: number | null;
  }[];
  images: {
    id: string;
    skuId: string;
    filePath: string | null;
    width: number | null;
    height: number | null;
    status: string | null;
    isBest: boolean | null;
    source: string | null;
    imageTypeSlug: string | null;
  }[];
  tags: {
    tagName: string | null;
    dimension: string | null;
  }[];
  wholesalePrice: number | null;
  retailPrice: number | null;
  msrp: number | null;
}
