import "dotenv/config";
import express from "express";
// @ts-ignore - dependency is added in package.json and resolved when installed locally.
import Database from "better-sqlite3";
// @ts-ignore - dependency is added in package.json and resolved when installed locally.
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "./generated/prisma/client.js";

type TransactionKind = "INCOME" | "EXPENSE";
type SatisfactionLevel = "SATISFIED" | "NORMAL" | "REGRET";
type SpendingStyle = "INVESTMENT" | "CONSUMPTION" | "WASTE";
type PaymentMethod = "CASH" | "CARD" | "QR" | "BANK_TRANSFER" | "OTHER";

const sqlitePath =
  process.env.DATABASE_URL?.replace("file:", "") || "./prisma/dev.db";
const sqlite = new Database(sqlitePath);
const adapter = new PrismaBetterSqlite3(sqlite);
const prisma = new PrismaClient({ adapter, log: ["warn", "error"] }) as any;

const app = express();
const PORT = Number(process.env.PORT || 8888);

const transactionKinds: TransactionKind[] = ["INCOME", "EXPENSE"];
const satisfactionLevels: SatisfactionLevel[] = [
  "SATISFIED",
  "NORMAL",
  "REGRET",
];
const spendingStyles: SpendingStyle[] = ["INVESTMENT", "CONSUMPTION", "WASTE"];
const paymentMethods: PaymentMethod[] = [
  "CASH",
  "CARD",
  "QR",
  "BANK_TRANSFER",
  "OTHER",
];

type TransactionRecord = {
  id?: number;
  kind: TransactionKind;
  amount: number;
  occurredAt: Date;
  category: string;
  paymentMethod: PaymentMethod;
  satisfaction: SatisfactionLevel;
  spendingStyle: SpendingStyle;
  memo: string | null;
  receiptImageUrl: string | null;
  receiptText: string | null;
  createdAt?: Date;
  updatedAt?: Date;
};

type SplitSettlementRecord = {
  id: number;
  title: string;
  totalAmount: number;
  participantsText: string;
  contributionsText: string;
  resultText: string;
  createdAt: Date;
  updatedAt: Date;
};

function toIsoMonth(date: Date) {
  return date.toISOString().slice(0, 7);
}

function toIsoDate(date: Date) {
  return date.toISOString().slice(0, 10);
}

function parseMonthKey(value?: string) {
  if (!value || !/^\d{4}-\d{2}$/.test(value)) {
    return toIsoMonth(new Date());
  }

  return value;
}

function startOfMonthUtc(monthKey: string) {
  const [yearText = "1970", monthText = "01"] = monthKey.split("-");
  const year = Number.parseInt(yearText, 10);
  const month = Number.parseInt(monthText, 10);
  return new Date(Date.UTC(year, month - 1, 1));
}

function endOfMonthUtc(monthKey: string) {
  const [yearText = "1970", monthText = "01"] = monthKey.split("-");
  const year = Number.parseInt(yearText, 10);
  const month = Number.parseInt(monthText, 10);
  return new Date(Date.UTC(year, month, 1));
}

function startOfYearUtc(year: number) {
  return new Date(Date.UTC(year, 0, 1));
}

function endOfYearUtc(year: number) {
  return new Date(Date.UTC(year + 1, 0, 1));
}

function parseDateInput(value?: string) {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return null;
  }

  return new Date(`${value}T12:00:00.000Z`);
}

function formatCurrency(value: number) {
  return new Intl.NumberFormat("ja-JP").format(value);
}

function sum(values: number[]) {
  return values.reduce((total, current) => total + current, 0);
}

function clampInt(value: unknown, fallback = 0) {
  const parsed = Number.parseInt(String(value ?? ""), 10);

  if (Number.isNaN(parsed)) {
    return fallback;
  }

  return parsed;
}

function parseEnumValue<T extends string>(
  value: unknown,
  allowedValues: readonly T[],
  fallback: T,
) {
  const stringValue = String(value ?? "");
  return allowedValues.includes(stringValue as T)
    ? (stringValue as T)
    : fallback;
}

function transactionToView(transaction: any) {
  return {
    ...transaction,
    occurredAt: toIsoDate(transaction.occurredAt),
    amountLabel: formatCurrency(transaction.amount),
  };
}

async function fetchTransactions(
  monthKey?: string,
): Promise<TransactionRecord[]> {
  const where = monthKey
    ? {
        occurredAt: {
          gte: startOfMonthUtc(monthKey),
          lt: endOfMonthUtc(monthKey),
        },
      }
    : undefined;

  const transactions = (await prisma.transaction.findMany({
    where,
    orderBy: {
      occurredAt: "desc",
    },
  })) as unknown as TransactionRecord[];

  return transactions.map(transactionToView);
}

function buildDailyRows(transactions: TransactionRecord[], monthKey: string) {
  const [yearText = "1970", monthText = "01"] = monthKey.split("-");
  const year = Number.parseInt(yearText, 10);
  const month = Number.parseInt(monthText, 10);
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const rows = Array.from({ length: daysInMonth }, (_, index) => {
    const day = index + 1;
    const dateKey = `${monthKey}-${String(day).padStart(2, "0")}`;
    return {
      dateKey,
      day,
      weekday: new Date(Date.UTC(year, month - 1, day)).getUTCDay(),
      income: 0,
      expense: 0,
    };
  });

  for (const transaction of transactions) {
    const index = Number(toIsoDate(transaction.occurredAt).slice(-2)) - 1;
    const row = rows[index];

    if (row) {
      if (transaction.kind === "INCOME") {
        row.income += transaction.amount;
      } else {
        row.expense += transaction.amount;
      }
    }
  }

  return rows;
}

function buildCategoryBreakdown(transactions: TransactionRecord[]) {
  const buckets = new Map<string, number>();

  for (const transaction of transactions.filter(
    (item) => item.kind === "EXPENSE",
  )) {
    buckets.set(
      transaction.category,
      (buckets.get(transaction.category) ?? 0) + transaction.amount,
    );
  }

  const total = sum([...buckets.values()]);

  return [...buckets.entries()]
    .sort((left, right) => right[1] - left[1])
    .map(([category, amount]) => ({
      category,
      amount,
      amountLabel: formatCurrency(amount),
      share: total === 0 ? 0 : Math.round((amount / total) * 1000) / 10,
    }));
}

function buildCountBreakdown<T extends string>(
  transactions: TransactionRecord[],
  key: "satisfaction" | "spendingStyle",
) {
  const buckets = new Map<string, number>();

  for (const transaction of transactions) {
    const value = transaction[key] as T;
    buckets.set(value, (buckets.get(value) ?? 0) + 1);
  }

  return [...buckets.entries()].map(([label, count]) => ({ label, count }));
}

function buildMonthlyGraph(transactions: TransactionRecord[], year: number) {
  const result = Array.from({ length: 12 }, (_, index) => {
    const monthKey = `${year}-${String(index + 1).padStart(2, "0")}`;
    return {
      month: index + 1,
      monthKey,
      income: 0,
      expense: 0,
    };
  });

  for (const transaction of transactions) {
    const monthIndex = transaction.occurredAt.getUTCMonth();
    const yearValue = transaction.occurredAt.getUTCFullYear();

    if (yearValue === year) {
      const bucket = result[monthIndex];

      if (bucket) {
        if (transaction.kind === "INCOME") {
          bucket.income += transaction.amount;
        } else {
          bucket.expense += transaction.amount;
        }
      }
    }
  }

  return result.map((item) => ({
    ...item,
    balance: item.income - item.expense,
  }));
}

function calculateSplitSettlement(
  totalAmount: number,
  participants: { name: string; paidAmount: number }[],
) {
  const participantsWithBalance = participants.map((participant) => ({
    ...participant,
    share: Math.floor(totalAmount / participants.length),
    balance:
      participant.paidAmount - Math.floor(totalAmount / participants.length),
  }));

  let remainder =
    totalAmount -
    Math.floor(totalAmount / participants.length) * participants.length;

  for (const participant of participantsWithBalance) {
    if (remainder <= 0) {
      break;
    }

    participant.share += 1;
    participant.balance -= 1;
    remainder -= 1;
  }

  const creditors = participantsWithBalance.filter(
    (participant) => participant.balance > 0,
  );
  const debtors = participantsWithBalance.filter(
    (participant) => participant.balance < 0,
  );
  const transfers: { from: string; to: string; amount: number }[] = [];

  let creditorIndex = 0;
  let debtorIndex = 0;

  while (creditorIndex < creditors.length && debtorIndex < debtors.length) {
    const creditor = creditors[creditorIndex];
    const debtor = debtors[debtorIndex];

    if (!creditor || !debtor) {
      break;
    }

    const amount = Math.min(creditor.balance, Math.abs(debtor.balance));

    transfers.push({
      from: debtor.name,
      to: creditor.name,
      amount,
    });

    creditor.balance -= amount;
    debtor.balance += amount;

    if (creditor.balance === 0) {
      creditorIndex += 1;
    }

    if (debtor.balance === 0) {
      debtorIndex += 1;
    }
  }

  return {
    totalAmount,
    sharePerPerson: Math.floor(totalAmount / participants.length),
    participants: participantsWithBalance,
    transfers,
  };
}

async function buildMonthSummary(monthKey: string) {
  const transactions = (await prisma.transaction.findMany({
    where: {
      occurredAt: {
        gte: startOfMonthUtc(monthKey),
        lt: endOfMonthUtc(monthKey),
      },
    },
    orderBy: {
      occurredAt: "asc",
    },
  })) as unknown as TransactionRecord[];

  const transactionViews = transactions.map(transactionToView);
  const income = sum(
    transactions
      .filter((transaction: TransactionRecord) => transaction.kind === "INCOME")
      .map((transaction: TransactionRecord) => transaction.amount),
  );
  const expense = sum(
    transactions
      .filter(
        (transaction: TransactionRecord) => transaction.kind === "EXPENSE",
      )
      .map((transaction: TransactionRecord) => transaction.amount),
  );
  const [yearText = "1970", monthText = "01"] = monthKey.split("-");
  const daysInMonth = new Date(
    Date.UTC(Number.parseInt(yearText, 10), Number.parseInt(monthText, 10), 0),
  ).getUTCDate();
  const categoryBreakdown = buildCategoryBreakdown(transactions);
  const satisfactionBreakdown = buildCountBreakdown<SatisfactionLevel>(
    transactions,
    "satisfaction",
  );
  const spendingStyleBreakdown = buildCountBreakdown<SpendingStyle>(
    transactions,
    "spendingStyle",
  );

  return {
    monthKey,
    totals: {
      income,
      expense,
      balance: income - expense,
      averageDailyExpense: Math.round(expense / Math.max(daysInMonth, 1)),
    },
    transactions: transactionViews,
    dailyRows: buildDailyRows(transactions, monthKey),
    categoryBreakdown,
    satisfactionBreakdown,
    spendingStyleBreakdown,
  };
}

async function getYearlyGraphData(year: number) {
  const transactions = (await prisma.transaction.findMany({
    where: {
      occurredAt: {
        gte: startOfYearUtc(year),
        lt: endOfYearUtc(year),
      },
    },
  })) as unknown as TransactionRecord[];

  return buildMonthlyGraph(transactions, year);
}

app.set("view engine", "ejs");
app.set("views", "./views");
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

app.get("/", async (req, res) => {
  try {
    const monthKey = parseMonthKey(String(req.query.month ?? ""));
    const year = Number.parseInt(monthKey.slice(0, 4), 10);

    const [monthSummary, yearlyGraph, transactions, splitSessions] =
      await Promise.all([
        buildMonthSummary(monthKey),
        getYearlyGraphData(year),
        fetchTransactions(),
        prisma.splitSettlement.findMany({ orderBy: { createdAt: "desc" } }),
      ]);

    res.render("index", {
      initialData: {
        monthKey,
        year,
        monthSummary,
        yearlyGraph,
        transactions,
        splitSessions: (splitSessions as SplitSettlementRecord[]).map(
          (item) => ({
            ...item,
            participants: JSON.parse(item.participantsText) as Array<{
              name: string;
              paidAmount: number;
            }>,
            result: JSON.parse(item.resultText) as Array<{
              from: string;
              to: string;
              amount: number;
            }>,
          }),
        ),
      },
      enums: {
        transactionKinds,
        satisfactionLevels,
        spendingStyles,
        paymentMethods,
      },
    });
  } catch (error) {
    console.error("Initial page load failed:", error);
    res.status(500).send("画面の読み込みに失敗しました。");
  }
});

app.get("/api/transactions", async (req, res) => {
  try {
    const monthKey = parseMonthKey(
      req.query.month ? String(req.query.month) : undefined,
    );
    const transactions = await fetchTransactions(monthKey);
    res.json({ monthKey, items: transactions });
  } catch (error) {
    console.error("Transaction read failed:", error);
    res.status(500).json({ message: "取引一覧の取得に失敗しました。" });
  }
});

app.post("/api/transactions", async (req, res) => {
  try {
    const occurredAt = parseDateInput(req.body.occurredAt);

    if (!occurredAt) {
      res.status(400).json({ message: "日付を入力してください。" });
      return;
    }

    const transaction = await prisma.transaction.create({
      data: {
        kind: parseEnumValue(req.body.kind, transactionKinds, "EXPENSE"),
        amount: clampInt(req.body.amount),
        occurredAt,
        category: String(req.body.category || "未分類"),
        paymentMethod: parseEnumValue(
          req.body.paymentMethod,
          paymentMethods,
          "OTHER",
        ),
        satisfaction: parseEnumValue(
          req.body.satisfaction,
          satisfactionLevels,
          "NORMAL",
        ),
        spendingStyle: parseEnumValue(
          req.body.spendingStyle,
          spendingStyles,
          "CONSUMPTION",
        ),
        memo: String(req.body.memo || "").trim() || null,
        receiptImageUrl: String(req.body.receiptImageUrl || "").trim() || null,
        receiptText: String(req.body.receiptText || "").trim() || null,
      },
    });

    res.status(201).json({ transaction: transactionToView(transaction) });
  } catch (error) {
    console.error("Transaction create failed:", error);
    res.status(500).json({ message: "取引の保存に失敗しました。" });
  }
});

app.get("/api/analytics/summary", async (req, res) => {
  try {
    const monthKey = parseMonthKey(String(req.query.month ?? ""));
    const summary = await buildMonthSummary(monthKey);
    res.json(summary);
  } catch (error) {
    console.error("Month summary failed:", error);
    res.status(500).json({ message: "月次分析の取得に失敗しました。" });
  }
});

app.get("/api/analytics/monthly", async (req, res) => {
  try {
    const year = Number.parseInt(
      String(req.query.year || new Date().getUTCFullYear()),
      10,
    );
    const graph = await getYearlyGraphData(year);
    res.json({ year, items: graph });
  } catch (error) {
    console.error("Monthly graph failed:", error);
    res.status(500).json({ message: "月次グラフの取得に失敗しました。" });
  }
});

app.get("/api/calendar", async (req, res) => {
  try {
    const monthKey = parseMonthKey(String(req.query.month ?? ""));
    const summary = await buildMonthSummary(monthKey);
    res.json({
      monthKey,
      dailyRows: summary.dailyRows,
      totals: summary.totals,
    });
  } catch (error) {
    console.error("Calendar failed:", error);
    res.status(500).json({ message: "カレンダー情報の取得に失敗しました。" });
  }
});

app.get("/api/split-sessions", async (req, res) => {
  try {
    const sessions = (await prisma.splitSettlement.findMany({
      orderBy: { createdAt: "desc" },
    })) as SplitSettlementRecord[];
    res.json({
      items: sessions.map((item) => ({
        ...item,
        participants: JSON.parse(item.participantsText) as Array<{
          name: string;
          paidAmount: number;
        }>,
        result: JSON.parse(item.resultText),
      })),
    });
  } catch (error) {
    console.error("Split session read failed:", error);
    res.status(500).json({ message: "割り勘記録の取得に失敗しました。" });
  }
});

app.post("/api/split-sessions", async (req, res) => {
  try {
    const totalAmount = clampInt(req.body.totalAmount);
    const title = String(req.body.title || "割り勘").trim() || "割り勘";
    const participants = Array.isArray(req.body.participants)
      ? req.body.participants
      : JSON.parse(String(req.body.participants || "[]"));

    const normalizedParticipants = participants
      .map((participant: { name?: string; paidAmount?: string | number }) => ({
        name: String(participant.name || "").trim(),
        paidAmount: clampInt(participant.paidAmount),
      }))
      .filter(
        (participant: { name: string; paidAmount: number }) => participant.name,
      );

    if (normalizedParticipants.length === 0) {
      res.status(400).json({ message: "参加者を1人以上入力してください。" });
      return;
    }

    const result = calculateSplitSettlement(
      totalAmount,
      normalizedParticipants,
    );
    const session = await prisma.splitSettlement.create({
      data: {
        title,
        totalAmount,
        participantsText: JSON.stringify(normalizedParticipants),
        contributionsText: JSON.stringify(normalizedParticipants),
        resultText: JSON.stringify(result.transfers),
      },
    });

    res.status(201).json({
      session: {
        ...session,
        participants: normalizedParticipants,
        result: result.transfers,
      },
    });
  } catch (error) {
    console.error("Split session create failed:", error);
    res.status(500).json({ message: "割り勘計算の保存に失敗しました。" });
  }
});

app.listen(PORT, () => {
  console.log(`サーバーが動いたぞ！ http://localhost:${PORT}`);
});

async function shutdown() {
  await prisma.$disconnect();
  sqlite.close();
}

process.on("SIGINT", async () => {
  await shutdown();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  await shutdown();
  process.exit(0);
});
