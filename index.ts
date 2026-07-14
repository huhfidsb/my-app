import "dotenv/config";
import express from "express";
// @ts-ignore - installed during the Render build

import { PrismaClient } from "./generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";

type TransactionKind = "INCOME" | "EXPENSE";
type SatisfactionLevel = "SATISFIED" | "NORMAL" | "REGRET";
type SpendingStyle = "INVESTMENT" | "CONSUMPTION" | "WASTE";
type PaymentMethod = "CASH" | "CARD" | "QR" | "BANK_TRANSFER" | "OTHER";

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL!,
});

const adapter = new PrismaPg(pool);

const prisma = new PrismaClient({
  adapter,
  log: ["query"],
});

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

// 1件の支払い：誰が払ったか(payer)、その支払いが誰の分だったか(coveredBy)
type SplitPayment = {
  payer: string;
  amount: number;
  coveredBy: string[];
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

function addMonths(monthKey: string, delta: number) {
  const [yearText = "1970", monthText = "01"] = monthKey.split("-");
  const date = new Date(
    Date.UTC(
      Number.parseInt(yearText, 10),
      Number.parseInt(monthText, 10) - 1 + delta,
      1,
    ),
  );
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
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

function buildTransactionData(body: any) {
  return {
    kind: parseEnumValue(body.kind, transactionKinds, "EXPENSE"),
    amount: clampInt(body.amount),
    category: String(body.category || "未分類"),
    paymentMethod: parseEnumValue(body.paymentMethod, paymentMethods, "OTHER"),
    satisfaction: parseEnumValue(
      body.satisfaction,
      satisfactionLevels,
      "NORMAL",
    ),
    spendingStyle: parseEnumValue(
      body.spendingStyle,
      spendingStyles,
      "CONSUMPTION",
    ),
    memo: String(body.memo || "").trim() || null,
  };
}

function parseSplitPayload(body: any) {
  const title = String(body.title || "割り勘").trim() || "割り勘";

  const rawParticipants: unknown[] = Array.isArray(body.participants)
    ? body.participants
    : JSON.parse(String(body.participants || "[]"));

  const participants = rawParticipants
    .map((name) => String(name ?? "").trim())
    .filter((name) => name.length > 0);

  if (participants.length === 0) {
    return null;
  }

  const rawPayments: Array<{
    payer?: string;
    amount?: string | number;
    coveredBy?: unknown;
  }> = Array.isArray(body.payments)
    ? body.payments
    : JSON.parse(String(body.payments || "[]"));

  const payments: SplitPayment[] = rawPayments
    .map((payment) => {
      const coveredByRaw = Array.isArray(payment.coveredBy)
        ? payment.coveredBy
        : [];

      return {
        payer: String(payment.payer || "").trim(),
        amount: clampInt(payment.amount),
        coveredBy: coveredByRaw
          .map((name) => String(name ?? "").trim())
          .filter((name) => participants.includes(name)),
      };
    })
    .filter(
      (payment) =>
        payment.payer &&
        participants.includes(payment.payer) &&
        payment.amount > 0,
    );

  if (payments.length === 0) {
    return null;
  }

  return { title, participants, payments };
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

  const transactions = await prisma.transaction.findMany({
    where,
    orderBy: {
      occurredAt: "desc",
    },
  });

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

function buildCategoryBreakdown(
  transactions: TransactionRecord[],
  kind: TransactionKind = "EXPENSE",
) {
  const buckets = new Map<string, number>();

  for (const transaction of transactions.filter((item) => item.kind === kind)) {
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
  participants: string[],
  payments: SplitPayment[],
) {
  const balances = new Map<string, number>();

  for (const name of participants) {
    balances.set(name, 0);
  }

  for (const payment of payments) {
    // 支払った人はその全額をプラス（後で精算相手からもらう分）
    const payerBalance = balances.get(payment.payer) ?? 0;
    balances.set(payment.payer, payerBalance + payment.amount);

    // 対象者未指定なら参加者全員で割る
    const coveredBy =
      payment.coveredBy.length > 0 ? payment.coveredBy : participants;
    const base = Math.floor(payment.amount / coveredBy.length);
    let remainder = payment.amount - base * coveredBy.length;

    for (const name of coveredBy) {
      const extra = remainder > 0 ? 1 : 0;

      if (extra) {
        remainder -= 1;
      }

      const currentBalance = balances.get(name) ?? 0;
      balances.set(name, currentBalance - base - extra);
    }
  }

  const creditors: { name: string; balance: number }[] = [];
  const debtors: { name: string; balance: number }[] = [];

  for (const [name, balance] of balances) {
    if (balance > 0) {
      creditors.push({ name, balance });
    } else if (balance < 0) {
      debtors.push({ name, balance });
    }
  }

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

    if (amount > 0) {
      transfers.push({
        from: debtor.name,
        to: creditor.name,
        amount,
      });
    }

    creditor.balance -= amount;
    debtor.balance += amount;

    if (creditor.balance === 0) {
      creditorIndex += 1;
    }

    if (debtor.balance === 0) {
      debtorIndex += 1;
    }
  }

  const totalAmount = sum(payments.map((payment) => payment.amount));

  return {
    totalAmount,
    balances: [...balances.entries()].map(([name, balance]) => ({
      name,
      balance,
    })),
    transfers,
  };
}

async function buildMonthSummary(monthKey: string) {
  const transactions = await prisma.transaction.findMany({
    where: {
      occurredAt: {
        gte: startOfMonthUtc(monthKey),
        lt: endOfMonthUtc(monthKey),
      },
    },
  });

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
  const categoryBreakdown = buildCategoryBreakdown(transactions, "EXPENSE");
  const incomeCategoryBreakdown = buildCategoryBreakdown(
    transactions,
    "INCOME",
  );
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
    incomeCategoryBreakdown,
    satisfactionBreakdown,
    spendingStyleBreakdown,
  };
}

async function getYearlyGraphData(year: number) {
  const transactions = await prisma.transaction.findMany({
    where: {
      occurredAt: {
        gte: startOfYearUtc(year),
        lt: endOfYearUtc(year),
      },
    },
  });

  return buildMonthlyGraph(transactions, year);
}

async function buildSavingsAnalytics(monthKey: string) {
  const previousMonthKey = addMonths(monthKey, -1);

  const [
    incomeAgg,
    expenseAgg,
    currentTransactions,
    previousTransactions,
    goalSetting,
  ] = await Promise.all([
    prisma.transaction.aggregate({
      _sum: { amount: true },
      where: { kind: "INCOME" },
    }),
    prisma.transaction.aggregate({
      _sum: { amount: true },
      where: { kind: "EXPENSE" },
    }),
    prisma.transaction.findMany({
      where: {
        occurredAt: {
          gte: startOfMonthUtc(monthKey),
          lt: endOfMonthUtc(monthKey),
        },
      },
    }),
    prisma.transaction.findMany({
      where: {
        occurredAt: {
          gte: startOfMonthUtc(previousMonthKey),
          lt: endOfMonthUtc(previousMonthKey),
        },
      },
    }),
    prisma.appSetting.findUnique({ where: { key: "savingsGoalAmount" } }),
  ]);

  const totalIncome = incomeAgg._sum.amount ?? 0;
  const totalExpense = expenseAgg._sum.amount ?? 0;
  const totalSavings = totalIncome - totalExpense;
  const savingsGoal = clampInt(goalSetting?.value, 0);

  const currentIncome = sum(
    currentTransactions
      .filter((t: TransactionRecord) => t.kind === "INCOME")
      .map((t: TransactionRecord) => t.amount),
  );
  const currentExpense = sum(
    currentTransactions
      .filter((t: TransactionRecord) => t.kind === "EXPENSE")
      .map((t: TransactionRecord) => t.amount),
  );

  const currentCategoryMap = new Map<string, number>();
  for (const transaction of currentTransactions as TransactionRecord[]) {
    if (transaction.kind === "EXPENSE") {
      currentCategoryMap.set(
        transaction.category,
        (currentCategoryMap.get(transaction.category) ?? 0) +
          transaction.amount,
      );
    }
  }

  const previousCategoryMap = new Map<string, number>();
  for (const transaction of previousTransactions as TransactionRecord[]) {
    if (transaction.kind === "EXPENSE") {
      previousCategoryMap.set(
        transaction.category,
        (previousCategoryMap.get(transaction.category) ?? 0) +
          transaction.amount,
      );
    }
  }

  const categoryNames = new Set([
    ...currentCategoryMap.keys(),
    ...previousCategoryMap.keys(),
  ]);

  const categorySavings = [...categoryNames]
    .map((category) => {
      const currentAmount = currentCategoryMap.get(category) ?? 0;
      const previousAmount = previousCategoryMap.get(category) ?? 0;
      const rate =
        previousAmount > 0
          ? Math.round(
              ((previousAmount - currentAmount) / previousAmount) * 1000,
            ) / 10
          : null;

      return {
        category,
        currentAmount,
        previousAmount,
        rate,
      };
    })
    .sort((left, right) => right.currentAmount - left.currentAmount);

  return {
    monthKey,
    previousMonthKey,
    totalIncome,
    totalExpense,
    totalSavings,
    savingsGoal,
    goalProgress:
      savingsGoal > 0
        ? Math.min(100, Math.round((totalSavings / savingsGoal) * 1000) / 10)
        : null,
    currentMonth: {
      income: currentIncome,
      expense: currentExpense,
      balance: currentIncome - currentExpense,
      savingsRate:
        currentIncome > 0
          ? Math.round(
              ((currentIncome - currentExpense) / currentIncome) * 1000,
            ) / 10
          : null,
    },
    categorySavings,
  };
}

app.set("view engine", "ejs");
app.set("views", "./views");
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

app.get("/", async (req, res) => {
  try {
    const monthKey = toIsoMonth(new Date());
    const year = Number.parseInt(monthKey.slice(0, 4), 10);

    const [
      monthSummary,
      yearlyGraph,
      transactions,
      splitSessions,
      savings,
      categories,
    ] = await Promise.all([
      buildMonthSummary(monthKey),
      getYearlyGraphData(year),
      fetchTransactions(monthKey),
      prisma.splitSettlement.findMany({
        where: {
          createdAt: {
            gte: startOfMonthUtc(monthKey),
            lt: endOfMonthUtc(monthKey),
          },
        },
        orderBy: { createdAt: "desc" },
      }),
      buildSavingsAnalytics(monthKey),
      prisma.category.findMany({
        orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
      }),
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
            participants: JSON.parse(item.participantsText) as string[],
            payments: JSON.parse(item.contributionsText) as SplitPayment[],
            result: JSON.parse(item.resultText) as Array<{
              from: string;
              to: string;
              amount: number;
            }>,
          }),
        ),
        savings,
        categories,
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
        ...buildTransactionData(req.body),
        occurredAt,
      },
    });

    res.status(201).json({ transaction: transactionToView(transaction) });
  } catch (error) {
    console.error("Transaction create failed:", error);
    res.status(500).json({ message: "取引の保存に失敗しました。" });
  }
});

app.put("/api/transactions/:id", async (req, res) => {
  try {
    const id = clampInt(req.params.id);
    const occurredAt = parseDateInput(req.body.occurredAt);

    if (!occurredAt) {
      res.status(400).json({ message: "日付を入力してください。" });
      return;
    }

    const transaction = await prisma.transaction.update({
      where: { id },
      data: {
        ...buildTransactionData(req.body),
        occurredAt,
      },
    });

    res.json({ transaction: transactionToView(transaction) });
  } catch (error) {
    console.error("Transaction update failed:", error);
    res.status(500).json({ message: "取引の更新に失敗しました。" });
  }
});

app.delete("/api/transactions/:id", async (req, res) => {
  try {
    const id = clampInt(req.params.id);
    await prisma.transaction.delete({ where: { id } });
    res.status(204).end();
  } catch (error) {
    console.error("Transaction delete failed:", error);
    res.status(500).json({ message: "取引の削除に失敗しました。" });
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

app.get("/api/analytics/savings", async (req, res) => {
  try {
    const monthKey = parseMonthKey(String(req.query.month ?? ""));
    const savings = await buildSavingsAnalytics(monthKey);
    res.json(savings);
  } catch (error) {
    console.error("Savings analytics failed:", error);
    res.status(500).json({ message: "貯蓄分析の取得に失敗しました。" });
  }
});

app.put("/api/settings/savings-goal", async (req, res) => {
  try {
    const amount = Math.max(0, clampInt(req.body.amount, 0));
    await prisma.appSetting.upsert({
      where: { key: "savingsGoalAmount" },
      update: { value: String(amount) },
      create: { key: "savingsGoalAmount", value: String(amount) },
    });
    res.json({ savingsGoal: amount });
  } catch (error) {
    console.error("Savings goal update failed:", error);
    res.status(500).json({ message: "目標額の保存に失敗しました。" });
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
    const monthKey = parseMonthKey(String(req.query.month ?? ""));
    const sessions = (await prisma.splitSettlement.findMany({
      where: {
        createdAt: {
          gte: startOfMonthUtc(monthKey),
          lt: endOfMonthUtc(monthKey),
        },
      },
      orderBy: { createdAt: "desc" },
    })) as SplitSettlementRecord[];
    res.json({
      monthKey,
      items: sessions.map((item) => ({
        ...item,
        participants: JSON.parse(item.participantsText) as string[],
        payments: JSON.parse(item.contributionsText) as SplitPayment[],
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
    const parsed = parseSplitPayload(req.body);

    if (!parsed) {
      res.status(400).json({
        message:
          "参加者を1人以上、支払い明細（誰がいくら払ったか）を1件以上入力してください。",
      });
      return;
    }

    const result = calculateSplitSettlement(
      parsed.participants,
      parsed.payments,
    );

    const session = await prisma.splitSettlement.create({
      data: {
        title: parsed.title,
        totalAmount: result.totalAmount,
        participantsText: JSON.stringify(parsed.participants),
        contributionsText: JSON.stringify(parsed.payments),
        resultText: JSON.stringify(result.transfers),
      },
    });

    res.status(201).json({
      session: {
        ...session,
        participants: parsed.participants,
        payments: parsed.payments,
        result: result.transfers,
      },
    });
  } catch (error) {
    console.error("Split session create failed:", error);
    res.status(500).json({ message: "割り勘計算の保存に失敗しました。" });
  }
});

app.put("/api/split-sessions/:id", async (req, res) => {
  try {
    const id = clampInt(req.params.id);
    const parsed = parseSplitPayload(req.body);

    if (!parsed) {
      res.status(400).json({
        message:
          "参加者を1人以上、支払い明細（誰がいくら払ったか）を1件以上入力してください。",
      });
      return;
    }

    const result = calculateSplitSettlement(
      parsed.participants,
      parsed.payments,
    );

    const session = await prisma.splitSettlement.update({
      where: { id },
      data: {
        title: parsed.title,
        totalAmount: result.totalAmount,
        participantsText: JSON.stringify(parsed.participants),
        contributionsText: JSON.stringify(parsed.payments),
        resultText: JSON.stringify(result.transfers),
      },
    });

    res.json({
      session: {
        ...session,
        participants: parsed.participants,
        payments: parsed.payments,
        result: result.transfers,
      },
    });
  } catch (error) {
    console.error("Split session update failed:", error);
    res.status(500).json({ message: "割り勘記録の更新に失敗しました。" });
  }
});

app.delete("/api/split-sessions/:id", async (req, res) => {
  try {
    const id = clampInt(req.params.id);
    await prisma.splitSettlement.delete({ where: { id } });
    res.status(204).end();
  } catch (error) {
    console.error("Split session delete failed:", error);
    res.status(500).json({ message: "割り勘記録の削除に失敗しました。" });
  }
});

app.get("/api/categories", async (req, res) => {
  try {
    const categories = await prisma.category.findMany({
      orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
    });
    res.json({ items: categories });
  } catch (error) {
    console.error("Category list failed:", error);
    res.status(500).json({ message: "カテゴリー一覧の取得に失敗しました。" });
  }
});

app.post("/api/categories", async (req, res) => {
  try {
    const name = String(req.body.name || "").trim();

    if (!name) {
      res.status(400).json({ message: "カテゴリー名を入力してください。" });
      return;
    }

    const maxOrder = await prisma.category.aggregate({
      _max: { sortOrder: true },
    });

    const category = await prisma.category.create({
      data: { name, sortOrder: (maxOrder._max.sortOrder ?? -1) + 1 },
    });

    res.status(201).json({ category });
  } catch (error) {
    console.error("Category create failed:", error);
    res.status(500).json({ message: "カテゴリーの追加に失敗しました。" });
  }
});

app.put("/api/categories/:id", async (req, res) => {
  try {
    const id = clampInt(req.params.id);
    const name = String(req.body.name || "").trim();

    if (!name) {
      res.status(400).json({ message: "カテゴリー名を入力してください。" });
      return;
    }

    const category = await prisma.category.update({
      where: { id },
      data: { name },
    });

    res.json({ category });
  } catch (error) {
    console.error("Category update failed:", error);
    res.status(500).json({ message: "カテゴリーの更新に失敗しました。" });
  }
});

app.delete("/api/categories/:id", async (req, res) => {
  try {
    const id = clampInt(req.params.id);
    await prisma.category.delete({ where: { id } });
    res.status(204).end();
  } catch (error) {
    console.error("Category delete failed:", error);
    res.status(500).json({ message: "カテゴリーの削除に失敗しました。" });
  }
});

async function ensureDefaultCategories() {
  const count = await prisma.category.count();

  if (count === 0) {
    const defaults = ["食費", "生活費", "趣味", "交通費"];
    await prisma.category.createMany({
      data: defaults.map((name, index) => ({ name, sortOrder: index })),
    });
  }
}

async function start() {
  try {
    await ensureDefaultCategories();
  } catch (error) {
    console.error("Category seed failed:", error);
  }

  app.listen(PORT, () => {
    console.log(`サーバーが動いたぞ！ http://localhost:${PORT}`);
  });
}

start();

async function shutdown() {
  await prisma.$disconnect();
}

process.on("SIGINT", async () => {
  await shutdown();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  await shutdown();
  process.exit(0);
});
