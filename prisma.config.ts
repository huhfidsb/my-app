import { defineConfig } from "@prisma/config";

export default defineConfig({
  schema: "./prisma/schema.prisma",
  // ここに「URLは環境変数の DATABASE_URL から取っておくれ」と書き足すのじゃ
  datasource: {
    url: process.env.DATABASE_URL,
  },
});
