import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: [
    "./src/modules/core/schema/index.ts",
    "./src/modules/sales/schema/index.ts",
    "./src/modules/catalog/schema/index.ts",
    "./src/modules/orders/schema/index.ts",
  ],
  out: "./drizzle/migrations",
  dialect: "sqlite",
  dbCredentials: {
    url: process.env.DATABASE_URL || "./data/the-frame.db",
  },
});
