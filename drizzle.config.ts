import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: [
    "./src/modules/core/schema/index.ts",
    "./src/modules/sales/schema/index.ts",
    "./src/modules/catalog/schema/index.ts",
    "./src/modules/orders/schema/index.ts",
    "./src/modules/inventory/schema/index.ts",
    "./src/modules/customers/schema/index.ts",
    "./src/modules/finance/schema/index.ts",
    "./src/modules/marketing/schema/index.ts",
  ],
  out: "./drizzle/migrations",
  dialect: "sqlite",
  dbCredentials: {
    url: process.env.DATABASE_URL || "./data/the-frame.db",
  },
});
