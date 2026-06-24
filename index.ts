import "dotenv/config";
import express from "express";
import { Pool } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "./generated/prisma/client";

// 【確認用】URLが読み込めているかターミナルに出力するぞ（パスワードは隠しておる）
console.log(
  "接続URLの確認:",
  process.env.DATABASE_URL
    ? "読み込み成功"
    : "読み込み失敗（.envが見つからないかも）",
);

// PostgreSQL への接続設定（SSLを有効にする設定を追加したぞ）
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }, // Render の DB に繋ぐためのまじないじゃ
});
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter, log: ["query"] });

const app = express();
const PORT = process.env.PORT || 8888;

app.set("view engine", "ejs");
app.set("views", "./views");
app.use(express.urlencoded({ extended: true }));

// 一覧表示
app.get("/", async (req, res) => {
  try {
    const users = await prisma.user.findMany();
    res.render("index", { users });
  } catch (error) {
    console.error("DB読み込みエラー:", error);
    res
      .status(500)
      .send("DBの読み込みに失敗したぞ。ターミナルのログを見ておくれ。");
  }
});

// ユーザー追加
app.post("/users", async (req, res) => {
  const name = req.body.name;
  if (name) {
    await prisma.user.create({ data: { name } });
  }
  res.redirect("/");
});

app.listen(PORT, () => {
  console.log(`サーバーが動いたぞ！ http://localhost:${PORT}`);
});
