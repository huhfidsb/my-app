import "dotenv/config";
import express from "express";
import type { Request, Response, NextFunction } from "express";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import * as db from "./lib/db.js";
import {
  hashSecret,
  verifySecret,
  parseCookies,
  createSessionCookieValue,
  readSessionCookieValue,
  sessionCookieHeader,
  clearSessionCookieHeader,
  generateDeviceSecret,
  hashDeviceSecret,
  deviceCookieHeader,
  clearDeviceCookieHeader,
  createVerifyToken,
  readVerifyToken,
  COOKIE_NAMES,
} from "./lib/auth.js";
import { sendMail, buildVerificationEmail } from "./lib/mailer.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

type TransactionKind = "INCOME" | "EXPENSE";

const app = express();
const PORT = Number(process.env.PORT || 8888);
const IS_PRODUCTION = process.env.NODE_ENV === "production";

const transactionKinds: TransactionKind[] = ["INCOME", "EXPENSE"];
const DEFAULT_EXPENSE_CATEGORIES = ["食費", "生活費", "交通費", "趣味"];
const DEFAULT_INCOME_CATEGORIES = ["給与", "副業", "お小遣い", "その他収入"];
const DEFAULT_PAYMENT_METHODS = [
  "現金",
  "クレジット",
  "デビット",
  "電子決済",
  "その他",
];

type TransactionRecord = db.TransactionRow;

type SplitPayment = {
  payer: string;
  amount: number;
  coveredBy: string[];
};

// ---------------- 日付・数値ユーティリティ ----------------

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
  return new Date(
    Date.UTC(
      Number.parseInt(yearText, 10),
      Number.parseInt(monthText, 10) - 1,
      1,
    ),
  );
}

function endOfMonthUtc(monthKey: string) {
  const [yearText = "1970", monthText = "01"] = monthKey.split("-");
  return new Date(
    Date.UTC(Number.parseInt(yearText, 10), Number.parseInt(monthText, 10), 1),
  );
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

function toUtcNoonDate(date: Date) {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 12),
  );
}

function addDaysUtc(date: Date, days: number) {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return toUtcNoonDate(next);
}

function addMonthsKeepingDay(date: Date, months: number, dayOfMonth: number) {
  const target = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + months + 1, 0, 12),
  );
  const lastDayOfTargetMonth = target.getUTCDate();
  return new Date(
    Date.UTC(
      date.getUTCFullYear(),
      date.getUTCMonth() + months,
      Math.min(dayOfMonth, lastDayOfTargetMonth),
      12,
    ),
  );
}

function formatCurrency(value: number) {
  return new Intl.NumberFormat("ja-JP").format(value);
}

function sum(values: number[]) {
  return values.reduce((total, current) => total + current, 0);
}

function clampInt(value: unknown, fallback = 0) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isNaN(parsed) ? fallback : parsed;
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

function transactionToView(transaction: TransactionRecord) {
  return {
    ...transaction,
    occurredAt: toIsoDate(transaction.occurredAt),
    amountLabel: formatCurrency(transaction.amount),
  };
}

function buildSubscriptionOccurrences(
  subscription: db.SubscriptionRow,
  limitDate: Date,
) {
  const startDate =
    parseDateInput(subscription.firstPaymentDate ?? "") ??
    toUtcNoonDate(subscription.createdAt);
  if (startDate > limitDate) return [];

  const occurrences: Date[] = [];
  const intervalValue = Math.max(1, subscription.intervalValue || 1);
  if (subscription.intervalUnit === "DAY") {
    let current = startDate;
    while (current <= limitDate) {
      occurrences.push(current);
      current = addDaysUtc(current, intervalValue);
    }
    return occurrences;
  }

  const dayOfMonth = startDate.getUTCDate();
  let current = startDate;
  while (current <= limitDate) {
    occurrences.push(current);
    current = addMonthsKeepingDay(current, intervalValue, dayOfMonth);
  }
  return occurrences;
}

function isDateWithinPausedRanges(
  dateIso: string,
  pausedRanges: { from: string; to: string }[],
) {
  return pausedRanges.some(
    (range) => dateIso >= range.from && dateIso < range.to,
  );
}

async function syncSubscriptionTransactions(userId: number) {
  const [subscriptions, transactions] = await Promise.all([
    db.listSubscriptions(userId),
    db.listTransactions(userId),
  ]);

  const existing = new Set(
    transactions
      .filter(
        (transaction) =>
          transaction.sourceType === "SUBSCRIPTION" &&
          transaction.subscriptionId !== null,
      )
      .map(
        (transaction) =>
          `${transaction.subscriptionId}:${toIsoDate(transaction.occurredAt)}`,
      ),
  );

  const today = toUtcNoonDate(new Date());
  const creates: Promise<db.TransactionRow | null>[] = [];

  for (const subscription of subscriptions) {
    const stoppedAt = subscription.stoppedAt
      ? parseDateInput(subscription.stoppedAt)
      : null;
    const activeLimit = subscription.active ? today : (stoppedAt ?? today);
    for (const occurrence of buildSubscriptionOccurrences(
      subscription,
      activeLimit,
    )) {
      const occurrenceIso = toIsoDate(occurrence);
      if (isDateWithinPausedRanges(occurrenceIso, subscription.pausedRanges))
        continue;
      const key = `${subscription.id}:${occurrenceIso}`;
      if (existing.has(key)) continue;
      existing.add(key);
      creates.push(
        db.createSubscriptionTransactionIfMissing(userId, {
          kind: "EXPENSE",
          amount: subscription.amount,
          occurredAt: occurrence,
          category: subscription.category,
          paymentMethod: subscription.paymentMethod,
          memo: `サブスク: ${subscription.name}`,
          sourceType: "SUBSCRIPTION",
          subscriptionId: subscription.id,
        }),
      );
    }
  }

  if (creates.length > 0) {
    // 同時実行で他のリクエストが先に同じ日付分を作っていても（ON CONFLICT DO NOTHING で
    // 何も起きない＝null が返るだけ）、1件の重複が他の正常な同期を巻き込んで失敗させないようにする
    await Promise.allSettled(creates);
  }
}

async function syncSubscriptionTransactionsSafely(userId: number) {
  try {
    await syncSubscriptionTransactions(userId);
  } catch (error) {
    console.error(
      "サブスク自動記録の同期に失敗しましたが、画面表示は継続します:",
      error,
    );
  }
}

async function syncAllSubscriptionTransactionsSafely() {
  try {
    const userIds = await db.listSubscriptionOwnerIds();
    await Promise.all(
      userIds.map((userId) => syncSubscriptionTransactionsSafely(userId)),
    );
  } catch (error) {
    console.error("サブスク定期同期に失敗しましたが、処理は継続します:", error);
  }
}

function buildTransactionData(
  body: any,
): db.TransactionInput & { occurredAt?: Date } {
  return {
    kind: parseEnumValue(body.kind, transactionKinds, "EXPENSE"),
    amount: clampInt(body.amount),
    category: String(body.category || "未分類"),
    paymentMethod: String(body.paymentMethod || "その他").trim() || "その他",
    memo: String(body.memo || "").trim() || null,
  } as db.TransactionInput;
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

// ---------------- 集計ロジック（userIdスコープ） ----------------

async function fetchTransactions(userId: number, monthKey?: string) {
  const range = monthKey
    ? { gte: startOfMonthUtc(monthKey), lt: endOfMonthUtc(monthKey) }
    : undefined;
  const transactions = await db.listTransactions(userId, range);
  return transactions.map(transactionToView);
}

function buildDailyRows(transactions: TransactionRecord[], monthKey: string) {
  const [yearText = "1970", monthText = "01"] = monthKey.split("-");
  const year = Number.parseInt(yearText, 10);
  const month = Number.parseInt(monthText, 10);
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const rows = Array.from({ length: daysInMonth }, (_, index) => {
    const day = index + 1;
    return {
      dateKey: `${monthKey}-${String(day).padStart(2, "0")}`,
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
      if (transaction.kind === "INCOME") row.income += transaction.amount;
      else row.expense += transaction.amount;
    }
  }

  return rows;
}

function buildCategoryBreakdown(
  transactions: TransactionRecord[],
  kind: TransactionKind = "EXPENSE",
) {
  return buildTransactionBreakdown(
    transactions,
    kind,
    (transaction) => transaction.category,
  );
}

function buildPaymentMethodBreakdown(
  transactions: TransactionRecord[],
  kind: TransactionKind = "EXPENSE",
) {
  return buildTransactionBreakdown(
    transactions,
    kind,
    (transaction) => transaction.paymentMethod,
  );
}

function buildTransactionBreakdown(
  transactions: TransactionRecord[],
  kind: TransactionKind,
  pickLabel: (transaction: TransactionRecord) => string,
) {
  const buckets = new Map<string, number>();
  for (const transaction of transactions.filter((item) => item.kind === kind)) {
    const label = pickLabel(transaction);
    buckets.set(label, (buckets.get(label) ?? 0) + transaction.amount);
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

function getNiceChartMaxValue(rawMaxValue: number) {
  if (rawMaxValue <= 0) return 10_000;
  const exponent = Math.floor(Math.log10(rawMaxValue));
  const base = 10 ** exponent;
  const scaled = rawMaxValue / base;
  const rounded = scaled <= 1 ? 1 : scaled <= 2 ? 2 : scaled <= 5 ? 5 : 10;
  return rounded * base;
}

function buildMonthlyGraph(transactions: TransactionRecord[], year: number) {
  const result = Array.from({ length: 12 }, (_, index) => ({
    month: index + 1,
    monthKey: `${year}-${String(index + 1).padStart(2, "0")}`,
    income: 0,
    expense: 0,
  }));

  for (const transaction of transactions) {
    const monthIndex = transaction.occurredAt.getUTCMonth();
    const yearValue = transaction.occurredAt.getUTCFullYear();
    if (yearValue === year) {
      const bucket = result[monthIndex];
      if (bucket) {
        if (transaction.kind === "INCOME") bucket.income += transaction.amount;
        else bucket.expense += transaction.amount;
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
  for (const name of participants) balances.set(name, 0);

  for (const payment of payments) {
    const payerBalance = balances.get(payment.payer) ?? 0;
    balances.set(payment.payer, payerBalance + payment.amount);

    const coveredBy =
      payment.coveredBy.length > 0 ? payment.coveredBy : participants;
    const base = Math.floor(payment.amount / coveredBy.length);
    let remainder = payment.amount - base * coveredBy.length;

    for (const name of coveredBy) {
      const extra = remainder > 0 ? 1 : 0;
      if (extra) remainder -= 1;
      const currentBalance = balances.get(name) ?? 0;
      balances.set(name, currentBalance - base - extra);
    }
  }

  const creditors: { name: string; balance: number }[] = [];
  const debtors: { name: string; balance: number }[] = [];
  for (const [name, balance] of balances) {
    if (balance > 0) creditors.push({ name, balance });
    else if (balance < 0) debtors.push({ name, balance });
  }

  const transfers: { from: string; to: string; amount: number }[] = [];
  let creditorIndex = 0;
  let debtorIndex = 0;

  while (creditorIndex < creditors.length && debtorIndex < debtors.length) {
    const creditor = creditors[creditorIndex];
    const debtor = debtors[debtorIndex];
    if (!creditor || !debtor) break;

    const amount = Math.min(creditor.balance, Math.abs(debtor.balance));
    if (amount > 0)
      transfers.push({ from: debtor.name, to: creditor.name, amount });

    creditor.balance -= amount;
    debtor.balance += amount;
    if (creditor.balance === 0) creditorIndex += 1;
    if (debtor.balance === 0) debtorIndex += 1;
  }

  return {
    totalAmount: sum(payments.map((payment) => payment.amount)),
    balances: [...balances.entries()].map(([name, balance]) => ({
      name,
      balance,
    })),
    transfers,
  };
}

async function buildMonthSummary(userId: number, monthKey: string) {
  const transactions = await db.listTransactions(userId, {
    gte: startOfMonthUtc(monthKey),
    lt: endOfMonthUtc(monthKey),
  });

  const transactionViews = transactions.map(transactionToView);
  const income = sum(
    transactions.filter((t) => t.kind === "INCOME").map((t) => t.amount),
  );
  const expense = sum(
    transactions.filter((t) => t.kind === "EXPENSE").map((t) => t.amount),
  );
  const [yearText = "1970", monthText = "01"] = monthKey.split("-");
  const daysInMonth = new Date(
    Date.UTC(Number.parseInt(yearText, 10), Number.parseInt(monthText, 10), 0),
  ).getUTCDate();

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
    categoryBreakdown: buildCategoryBreakdown(transactions, "EXPENSE"),
    incomeCategoryBreakdown: buildCategoryBreakdown(transactions, "INCOME"),
    paymentMethodBreakdown: buildPaymentMethodBreakdown(
      transactions,
      "EXPENSE",
    ),
    incomePaymentMethodBreakdown: buildPaymentMethodBreakdown(
      transactions,
      "INCOME",
    ),
  };
}

async function getYearlyGraphData(userId: number, year: number) {
  const transactions = await db.listTransactions(userId, {
    gte: startOfYearUtc(year),
    lt: endOfYearUtc(year),
  });
  return buildMonthlyGraph(transactions, year);
}

async function buildSavingsAnalytics(
  userId: number,
  monthKey: string,
  savingsGoal: number,
) {
  const previousMonthKey = addMonths(monthKey, -1);

  const [totalIncome, totalExpense, currentTransactions, previousTransactions] =
    await Promise.all([
      db.sumTransactions(userId, "INCOME"),
      db.sumTransactions(userId, "EXPENSE"),
      db.listTransactions(userId, {
        gte: startOfMonthUtc(monthKey),
        lt: endOfMonthUtc(monthKey),
      }),
      db.listTransactions(userId, {
        gte: startOfMonthUtc(previousMonthKey),
        lt: endOfMonthUtc(previousMonthKey),
      }),
    ]);

  const totalSavings = totalIncome - totalExpense;
  const currentIncome = sum(
    currentTransactions.filter((t) => t.kind === "INCOME").map((t) => t.amount),
  );
  const currentExpense = sum(
    currentTransactions
      .filter((t) => t.kind === "EXPENSE")
      .map((t) => t.amount),
  );

  const currentCategoryMap = new Map<string, number>();
  for (const transaction of currentTransactions) {
    if (transaction.kind === "EXPENSE") {
      currentCategoryMap.set(
        transaction.category,
        (currentCategoryMap.get(transaction.category) ?? 0) +
          transaction.amount,
      );
    }
  }

  const previousCategoryMap = new Map<string, number>();
  for (const transaction of previousTransactions) {
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
      return { category, currentAmount, previousAmount, rate };
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

async function buildBudgetInsights(userId: number, monthKey: string) {
  const previousMonthKey = addMonths(monthKey, -1);

  const [
    currentBudgets,
    previousBudgets,
    currentTransactions,
    previousTransactions,
  ] = await Promise.all([
    db.listBudgets(userId, monthKey),
    db.listBudgets(userId, previousMonthKey),
    db.listTransactions(userId, {
      gte: startOfMonthUtc(monthKey),
      lt: endOfMonthUtc(monthKey),
    }),
    db.listTransactions(userId, {
      gte: startOfMonthUtc(previousMonthKey),
      lt: endOfMonthUtc(previousMonthKey),
    }),
  ]);

  let previousResult: {
    totalBudget: number;
    totalActual: number;
    diff: number;
  } | null = null;
  if (previousBudgets.length > 0) {
    const totalBudget = sum(previousBudgets.map((b) => b.amount));
    const budgetedCategories = new Set(previousBudgets.map((b) => b.category));
    const totalActual = sum(
      previousTransactions
        .filter(
          (t) => t.kind === "EXPENSE" && budgetedCategories.has(t.category),
        )
        .map((t) => t.amount),
    );
    previousResult = {
      totalBudget,
      totalActual,
      diff: totalBudget - totalActual,
    };
  }

  let currentRemaining: {
    daysRemaining: number;
    categories: {
      category: string;
      budget: number;
      spent: number;
      remaining: number;
    }[];
  } | null = null;
  if (currentBudgets.length > 0) {
    const now = new Date();
    const [yearText = "1970", monthText = "01"] = monthKey.split("-");
    const daysInMonth = new Date(
      Date.UTC(
        Number.parseInt(yearText, 10),
        Number.parseInt(monthText, 10),
        0,
      ),
    ).getUTCDate();
    const isCurrentCalendarMonth = monthKey === toIsoMonth(now);
    const daysRemaining = isCurrentCalendarMonth
      ? Math.max(0, daysInMonth - now.getUTCDate() + 1)
      : daysInMonth;

    const categories = currentBudgets.map((budget) => {
      const spent = sum(
        currentTransactions
          .filter((t) => t.kind === "EXPENSE" && t.category === budget.category)
          .map((t) => t.amount),
      );
      return {
        category: budget.category,
        budget: budget.amount,
        spent,
        remaining: budget.amount - spent,
      };
    });

    currentRemaining = { daysRemaining, categories };
  }

  return { monthKey, previousMonthKey, previousResult, currentRemaining };
}

// ---------------- 認証ミドルウェア ----------------

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: db.UserRow;
    }
  }
}

function getCookies(req: Request) {
  return parseCookies(req.headers.cookie);
}

async function attachUser(req: Request, _res: Response, next: NextFunction) {
  try {
    const cookies = getCookies(req);
    const payload = readSessionCookieValue(cookies[COOKIE_NAMES.SESSION]);
    if (payload) {
      const user = await db.findUserById(payload.uid);
      if (user) req.user = user;
    }
  } catch (error) {
    console.error("セッション確認に失敗:", error);
  }
  next();
}

function requireAuthPage(req: Request, res: Response, next: NextFunction) {
  if (!req.user) {
    res.redirect("/login");
    return;
  }
  next();
}

function requireAuthApi(req: Request, res: Response, next: NextFunction) {
  if (!req.user) {
    res.status(401).json({ message: "ログインが必要です。" });
    return;
  }
  next();
}

function userPublicView(user: db.UserRow) {
  return {
    username: user.username,
    email: user.email,
    savingsGoalAmount: user.savingsGoalAmount,
    guidesEnabled: user.guidesEnabled,
  };
}

// ---------------- アプリ設定 ----------------

app.set("view engine", "ejs");
app.set("views", "./views");
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(attachUser);

const USERNAME_RE = /^[a-zA-Z0-9_.-]{3,32}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CODE_TTL_MS = 10 * 60 * 1000;
const CODE_REQUEST_COOLDOWN_MS = 60 * 1000;
const MAX_CODE_ATTEMPTS = 5;

function buildUsernameBase(email: string) {
  const localPart = email.split("@")[0] || "user";
  const normalized = localPart
    .replace(/[^a-zA-Z0-9_.-]/g, "")
    .replace(/^[_.-]+|[_.-]+$/g, "")
    .slice(0, 24);
  return normalized || "user";
}

async function generateUniqueUsername(email: string) {
  const base = buildUsernameBase(email);
  for (let index = 0; index < 1000; index += 1) {
    const suffix = index === 0 ? "" : `-${index + 1}`;
    const candidate = `${base}${suffix}`.slice(0, 32);
    if (!USERNAME_RE.test(candidate)) continue;
    const existing = await db.findUserByUsername(candidate);
    if (!existing) return candidate;
  }
  return `user-${Date.now()}`.slice(0, 32);
}

// メール認証コードの連投を防ぐ簡易クールダウン（メモリ上のみ。再起動でリセットされます）
const lastCodeRequestAt = new Map<string, number>();

function generateSixDigitCode(): string {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
}

async function issueVerificationCode(
  email: string,
  purpose: "register" | "reset",
) {
  const code = generateSixDigitCode();
  const expiresAt = new Date(Date.now() + CODE_TTL_MS);
  await db.createEmailVerification(email, purpose, hashSecret(code), expiresAt);
  const { subject, text } = buildVerificationEmail(code, purpose);
  await sendMail({ to: email, subject, text });
}

// ---------------- 認証ページ ----------------

app.get("/login", (req, res) => {
  if (req.user) {
    res.redirect("/");
    return;
  }
  res.render("login", { error: null });
});

app.post("/api/auth/register", async (req, res) => {
  try {
    const email = String(req.body.email || "")
      .trim()
      .toLowerCase();
    const password = String(req.body.password || "");

    if (!EMAIL_RE.test(email)) {
      res
        .status(400)
        .json({ message: "正しいメールアドレスを入力してください。" });
      return;
    }
    if (password.length < 8) {
      res
        .status(400)
        .json({ message: "パスワードは8文字以上にしてください。" });
      return;
    }

    const existing = await db.findUserByEmail(email);
    if (existing) {
      res
        .status(409)
        .json({ message: "このメールアドレスは既に登録されています。" });
      return;
    }

    const username = await generateUniqueUsername(email);
    const user = await db.createUser(username, email, hashSecret(password));
    await db.createDefaultCategories(user.id, [
      ...DEFAULT_EXPENSE_CATEGORIES.map((name) => ({
        name,
        kind: "EXPENSE" as const,
      })),
      ...DEFAULT_INCOME_CATEGORIES.map((name) => ({
        name,
        kind: "INCOME" as const,
      })),
    ]);
    await db.createDefaultPaymentMethods(user.id, DEFAULT_PAYMENT_METHODS);

    res.setHeader(
      "Set-Cookie",
      sessionCookieHeader(createSessionCookieValue(user.id), IS_PRODUCTION),
    );
    res.status(201).json({ user: userPublicView(user) });
  } catch (error) {
    console.error("登録に失敗:", error);
    res.status(500).json({ message: "登録に失敗しました。" });
  }
});

app.get("/logout", (req, res) => {
  res.setHeader("Set-Cookie", clearSessionCookieHeader(IS_PRODUCTION));
  res.redirect("/login");
});

// ---------------- 新規登録（メール認証 → ユーザー名・パスワード設定） ----------------

app.post("/api/auth/register/request-code", async (req, res) => {
  try {
    const email = String(req.body.email || "")
      .trim()
      .toLowerCase();
    if (!EMAIL_RE.test(email)) {
      res
        .status(400)
        .json({ message: "正しいメールアドレスを入力してください。" });
      return;
    }

    const existing = await db.findUserByEmail(email);
    if (existing) {
      res
        .status(409)
        .json({ message: "このメールアドレスは既に登録されています。" });
      return;
    }

    const lastRequest = lastCodeRequestAt.get(`register:${email}`) || 0;
    if (Date.now() - lastRequest < CODE_REQUEST_COOLDOWN_MS) {
      res.status(429).json({
        message: "コードを送信しました。1分ほど待ってから再度お試しください。",
      });
      return;
    }
    lastCodeRequestAt.set(`register:${email}`, Date.now());

    await issueVerificationCode(email, "register");
    res.json({ ok: true });
  } catch (error) {
    console.error("認証コード送信に失敗:", error);
    res.status(500).json({ message: "認証コードの送信に失敗しました。" });
  }
});

app.post("/api/auth/register/verify-code", async (req, res) => {
  try {
    const email = String(req.body.email || "")
      .trim()
      .toLowerCase();
    const code = String(req.body.code || "").trim();

    const verification = await db.findLatestEmailVerification(
      email,
      "register",
    );
    if (
      !verification ||
      verification.consumedAt ||
      verification.expiresAt.getTime() < Date.now()
    ) {
      res.status(400).json({
        message: "コードの有効期限が切れています。もう一度送信してください。",
      });
      return;
    }
    if (verification.attempts >= MAX_CODE_ATTEMPTS) {
      res.status(429).json({
        message:
          "試行回数が上限に達しました。もう一度コードを送信してください。",
      });
      return;
    }
    await db.incrementVerificationAttempts(verification.id);

    if (!verifySecret(code, verification.codeHash)) {
      res.status(400).json({ message: "コードが正しくありません。" });
      return;
    }

    await db.consumeEmailVerification(verification.id);
    res.json({ verifyToken: createVerifyToken(email, "register") });
  } catch (error) {
    console.error("認証コードの確認に失敗:", error);
    res.status(500).json({ message: "認証コードの確認に失敗しました。" });
  }
});

app.post("/api/auth/register/complete", async (req, res) => {
  try {
    const payload = readVerifyToken(String(req.body.verifyToken || ""));
    if (!payload || payload.purpose !== "register") {
      res.status(401).json({
        message:
          "メール認証が確認できませんでした。最初からやり直してください。",
      });
      return;
    }

    const username = String(req.body.username || "").trim();
    const password = String(req.body.password || "");

    if (!USERNAME_RE.test(username)) {
      res.status(400).json({
        message:
          "ユーザー名は半角英数字・_-. のみ、3〜32文字で入力してください。",
      });
      return;
    }
    if (password.length < 8) {
      res
        .status(400)
        .json({ message: "パスワードは8文字以上にしてください。" });
      return;
    }

    const existingUsername = await db.findUserByUsername(username);
    if (existingUsername) {
      res.status(409).json({ message: "そのユーザー名は既に使われています。" });
      return;
    }
    const existingEmail = await db.findUserByEmail(payload.email);
    if (existingEmail) {
      res
        .status(409)
        .json({ message: "このメールアドレスは既に登録されています。" });
      return;
    }

    const user = await db.createUser(
      username,
      payload.email,
      hashSecret(password),
    );
    await db.createDefaultCategories(user.id, [
      ...DEFAULT_EXPENSE_CATEGORIES.map((name) => ({
        name,
        kind: "EXPENSE" as const,
      })),
      ...DEFAULT_INCOME_CATEGORIES.map((name) => ({
        name,
        kind: "INCOME" as const,
      })),
    ]);
    await db.createDefaultPaymentMethods(user.id, DEFAULT_PAYMENT_METHODS);

    res.setHeader(
      "Set-Cookie",
      sessionCookieHeader(createSessionCookieValue(user.id), IS_PRODUCTION),
    );
    res.status(201).json({ user: userPublicView(user) });
  } catch (error) {
    console.error("登録に失敗:", error);
    res.status(500).json({ message: "登録に失敗しました。" });
  }
});

// ---------------- ログイン ----------------

app.post("/api/auth/login", async (req, res) => {
  try {
    const email = String(req.body.email || "")
      .trim()
      .toLowerCase();
    const password = String(req.body.password || "");

    const user = await db.findUserByEmail(email);
    if (!user || !verifySecret(password, user.passwordHash)) {
      res
        .status(401)
        .json({ message: "メールアドレスまたはパスワードが違います。" });
      return;
    }

    res.setHeader(
      "Set-Cookie",
      sessionCookieHeader(createSessionCookieValue(user.id), IS_PRODUCTION),
    );
    res.json({ user: userPublicView(user) });
  } catch (error) {
    console.error("ログインに失敗:", error);
    res.status(500).json({ message: "ログインに失敗しました。" });
  }
});

app.post("/api/auth/logout", (req, res) => {
  res.setHeader("Set-Cookie", clearSessionCookieHeader(IS_PRODUCTION));
  res.json({ ok: true });
});

// ---------------- パスワードを忘れた場合（登録メールアドレスから再設定） ----------------

app.post("/api/auth/password-reset/request", async (req, res) => {
  try {
    const email = String(req.body.email || "")
      .trim()
      .toLowerCase();
    if (!EMAIL_RE.test(email)) {
      res
        .status(400)
        .json({ message: "正しいメールアドレスを入力してください。" });
      return;
    }

    const lastRequest = lastCodeRequestAt.get(`reset:${email}`) || 0;
    if (Date.now() - lastRequest < CODE_REQUEST_COOLDOWN_MS) {
      res.status(429).json({
        message: "コードを送信しました。1分ほど待ってから再度お試しください。",
      });
      return;
    }
    lastCodeRequestAt.set(`reset:${email}`, Date.now());

    // メール登録の有無に関わらず同じ応答を返す（アカウントの存在を推測されないようにするため）
    const user = await db.findUserByEmail(email);
    if (user) {
      await issueVerificationCode(email, "reset");
    }
    res.json({ ok: true });
  } catch (error) {
    console.error("パスワード再設定コード送信に失敗:", error);
    res.status(500).json({ message: "コードの送信に失敗しました。" });
  }
});

app.post("/api/auth/password-reset/verify", async (req, res) => {
  try {
    const email = String(req.body.email || "")
      .trim()
      .toLowerCase();
    const code = String(req.body.code || "").trim();

    const verification = await db.findLatestEmailVerification(email, "reset");
    if (
      !verification ||
      verification.consumedAt ||
      verification.expiresAt.getTime() < Date.now()
    ) {
      res.status(400).json({
        message: "コードの有効期限が切れています。もう一度送信してください。",
      });
      return;
    }
    if (verification.attempts >= MAX_CODE_ATTEMPTS) {
      res.status(429).json({
        message:
          "試行回数が上限に達しました。もう一度コードを送信してください。",
      });
      return;
    }
    await db.incrementVerificationAttempts(verification.id);

    if (!verifySecret(code, verification.codeHash)) {
      res.status(400).json({ message: "コードが正しくありません。" });
      return;
    }

    await db.consumeEmailVerification(verification.id);
    const user = await db.findUserByEmail(email);
    res.json({
      verifyToken: createVerifyToken(email, "reset"),
      username: user?.username ?? null,
    });
  } catch (error) {
    console.error("パスワード再設定コードの確認に失敗:", error);
    res.status(500).json({ message: "コードの確認に失敗しました。" });
  }
});

app.post("/api/auth/password-reset/complete", async (req, res) => {
  try {
    const payload = readVerifyToken(String(req.body.verifyToken || ""));
    if (!payload || payload.purpose !== "reset") {
      res.status(401).json({
        message:
          "メール認証が確認できませんでした。最初からやり直してください。",
      });
      return;
    }

    const newPassword = String(req.body.newPassword || "");
    if (newPassword.length < 8) {
      res
        .status(400)
        .json({ message: "パスワードは8文字以上にしてください。" });
      return;
    }

    const user = await db.findUserByEmail(payload.email);
    if (!user) {
      res.status(404).json({ message: "アカウントが見つかりません。" });
      return;
    }

    await db.updateUserPassword(user.id, hashSecret(newPassword));
    res.setHeader(
      "Set-Cookie",
      sessionCookieHeader(createSessionCookieValue(user.id), IS_PRODUCTION),
    );
    res.json({ user: userPublicView(user) });
  } catch (error) {
    console.error("パスワード再設定に失敗:", error);
    res.status(500).json({ message: "パスワードの再設定に失敗しました。" });
  }
});

// ---------------- 生体認証（Face ID / 指紋）の端末登録・ログイン ----------------
// 注記：この実行環境ではnpmパッケージを追加インストールできないため、
// FIDO2署名の暗号検証（attestation/assertion verification）は行わず、
// 「端末に保存した高強度ランダムトークン(httpOnly cookie)を、WebAuthnの生体認証プロンプトで
// UI的にゲートする」簡易実装にしています。実運用でより厳密にしたい場合は
// @simplewebauthn/server 等の導入をご検討ください（README参照）。

app.get("/api/auth/webauthn/challenge", (_req, res) => {
  res.json({ challenge: crypto.randomBytes(32).toString("base64url") });
});

app.post("/api/auth/webauthn/register", requireAuthApi, async (req, res) => {
  try {
    const credentialId = String(req.body.credentialId || "").trim();
    const label = String(req.body.label || "").trim() || null;
    if (!credentialId) {
      res.status(400).json({ message: "credentialIdが必要です。" });
      return;
    }

    const deviceSecret = generateDeviceSecret();
    await db.createWebauthnCredential(
      req.user!.id,
      credentialId,
      hashDeviceSecret(deviceSecret),
      label,
    );

    res.setHeader(
      "Set-Cookie",
      deviceCookieHeader(deviceSecret, IS_PRODUCTION),
    );
    res.status(201).json({ ok: true });
  } catch (error: any) {
    if (String(error?.code) === "23505") {
      res.status(409).json({ message: "この端末は既に登録済みです。" });
      return;
    }
    console.error("生体認証デバイス登録に失敗:", error);
    res.status(500).json({ message: "登録に失敗しました。" });
  }
});

app.post("/api/auth/webauthn/login", async (req, res) => {
  try {
    const cookies = getCookies(req);
    const deviceSecret = cookies[COOKIE_NAMES.DEVICE];
    if (!deviceSecret) {
      res.status(401).json({ message: "この端末に登録情報がありません。" });
      return;
    }

    const credential = await db.findCredentialByDeviceSecretHash(
      hashDeviceSecret(deviceSecret),
    );
    if (!credential) {
      res.status(401).json({ message: "端末の登録情報が見つかりません。" });
      return;
    }

    const user = await db.findUserById(credential.userId);
    if (!user) {
      res.status(401).json({ message: "アカウントが見つかりません。" });
      return;
    }

    await db.touchCredential(credential.id);
    res.setHeader(
      "Set-Cookie",
      sessionCookieHeader(createSessionCookieValue(user.id), IS_PRODUCTION),
    );
    res.json({ user: userPublicView(user) });
  } catch (error) {
    console.error("生体認証ログインに失敗:", error);
    res.status(500).json({ message: "ログインに失敗しました。" });
  }
});

app.get("/api/auth/webauthn/credentials", requireAuthApi, async (req, res) => {
  try {
    const items = await db.listCredentialsForUser(req.user!.id);
    res.json({
      items: items.map((item) => ({
        id: item.id,
        label: item.label,
        createdAt: item.createdAt,
        lastUsedAt: item.lastUsedAt,
      })),
    });
  } catch (error) {
    console.error("端末一覧の取得に失敗:", error);
    res.status(500).json({ message: "端末一覧の取得に失敗しました。" });
  }
});

app.delete(
  "/api/auth/webauthn/credentials/:id",
  requireAuthApi,
  async (req, res) => {
    try {
      await db.deleteCredential(req.user!.id, clampInt(req.params.id));
      res.setHeader("Set-Cookie", clearDeviceCookieHeader(IS_PRODUCTION));
      res.status(204).end();
    } catch (error) {
      console.error("端末の削除に失敗:", error);
      res.status(500).json({ message: "端末の削除に失敗しました。" });
    }
  },
);

// ---------------- 設定 ----------------

app.put("/api/settings", requireAuthApi, async (req, res) => {
  try {
    const patch: {
      savingsGoalAmount?: number | null;
      guidesEnabled?: boolean;
    } = {};

    if (req.body.savingsGoalAmount !== undefined) {
      const raw = req.body.savingsGoalAmount;
      patch.savingsGoalAmount =
        raw === null || raw === "" ? null : Math.max(0, clampInt(raw, 0));
    }
    if (req.body.guidesEnabled !== undefined) {
      patch.guidesEnabled = Boolean(req.body.guidesEnabled);
    }

    await db.updateUserSettings(req.user!.id, patch);
    const user = await db.findUserById(req.user!.id);
    res.json({ user: userPublicView(user!) });
  } catch (error) {
    console.error("設定の更新に失敗:", error);
    res.status(500).json({ message: "設定の更新に失敗しました。" });
  }
});

app.put("/api/auth/username", requireAuthApi, async (req, res) => {
  try {
    const username = String(req.body.username || "").trim();
    if (!USERNAME_RE.test(username)) {
      res.status(400).json({
        message:
          "ユーザー名は半角英数字・_-. のみ、3〜32文字で入力してください。",
      });
      return;
    }
    const existing = await db.findUserByUsername(username);
    if (existing && existing.id !== req.user!.id) {
      res.status(409).json({ message: "そのユーザー名は既に使われています。" });
      return;
    }
    await db.updateUsername(req.user!.id, username);
    const user = await db.findUserById(req.user!.id);
    res.json({ user: userPublicView(user!) });
  } catch (error) {
    console.error("ユーザー名の変更に失敗:", error);
    res.status(500).json({ message: "ユーザー名の変更に失敗しました。" });
  }
});

app.delete("/api/auth/account", requireAuthApi, async (req, res) => {
  try {
    await db.deleteUser(req.user!.id);
    res.setHeader("Set-Cookie", [
      clearSessionCookieHeader(IS_PRODUCTION),
      clearDeviceCookieHeader(IS_PRODUCTION),
    ]);
    res.json({ ok: true });
  } catch (error) {
    console.error("退会処理に失敗:", error);
    res.status(500).json({ message: "退会処理に失敗しました。" });
  }
});

async function ensureDefaultCategoriesAndPaymentMethods(userId: number) {
  const [expenseCategories, incomeCategories, methods] = await Promise.all([
    db.listCategories(userId, "EXPENSE"),
    db.listCategories(userId, "INCOME"),
    db.listPaymentMethods(userId),
  ]);

  if (expenseCategories.length === 0) {
    await db.createDefaultCategories(
      userId,
      DEFAULT_EXPENSE_CATEGORIES.map((name) => ({
        name,
        kind: "EXPENSE" as const,
      })),
    );
  }
  if (incomeCategories.length === 0) {
    await db.createDefaultCategories(
      userId,
      DEFAULT_INCOME_CATEGORIES.map((name) => ({
        name,
        kind: "INCOME" as const,
      })),
    );
  }
  if (methods.length === 0) {
    await db.createDefaultPaymentMethods(userId, DEFAULT_PAYMENT_METHODS);
  }
}

// ---------------- ダッシュボード ----------------

app.get("/", requireAuthPage, async (req, res) => {
  try {
    const user = req.user!;
    const monthKey = toIsoMonth(new Date());
    const year = Number.parseInt(monthKey.slice(0, 4), 10);
    const savingsGoal = user.savingsGoalAmount ?? 0;

    await ensureDefaultCategoriesAndPaymentMethods(user.id);
    await syncSubscriptionTransactionsSafely(user.id);

    const [
      monthSummary,
      yearlyGraph,
      transactions,
      splitSessions,
      savings,
      categories,
      paymentMethods,
      subscriptions,
      budgets,
      budgetInsights,
    ] = await Promise.all([
      buildMonthSummary(user.id, monthKey),
      getYearlyGraphData(user.id, year),
      fetchTransactions(user.id, monthKey),
      db.listSplitSessions(user.id, {
        gte: startOfMonthUtc(monthKey),
        lt: endOfMonthUtc(monthKey),
      }),
      buildSavingsAnalytics(user.id, monthKey, savingsGoal),
      db.listCategories(user.id),
      db.listPaymentMethods(user.id),
      db.listSubscriptions(user.id),
      db.listBudgets(user.id, monthKey),
      buildBudgetInsights(user.id, monthKey),
    ]);

    res.render("index", {
      initialData: {
        monthKey,
        year,
        monthSummary,
        yearlyGraph,
        transactions,
        splitSessions: splitSessions.map((item) => ({
          ...item,
          participants: JSON.parse(item.participantsText) as string[],
          payments: JSON.parse(item.contributionsText) as SplitPayment[],
          result: JSON.parse(item.resultText) as Array<{
            from: string;
            to: string;
            amount: number;
          }>,
        })),
        savings,
        categories,
        paymentMethods,
        subscriptions: subscriptions.map((item) => ({
          ...item,
          amountLabel: formatCurrency(item.amount),
          intervalLabel:
            item.intervalUnit === "DAY"
              ? `${item.intervalValue}日ごと`
              : `${item.intervalValue}ヶ月ごと`,
          firstPaymentDateLabel: item.firstPaymentDate ?? "未設定",
          statusLabel: item.active ? "稼働中" : "停止中",
        })),
        budgets,
        budgetInsights,
        user: userPublicView(user),
      },
      enums: { transactionKinds },
    });
  } catch (error) {
    console.error("画面の読み込みに失敗:", error);
    res.status(500).send("画面の読み込みに失敗しました。");
  }
});

// ---------------- 取引 ----------------

app.get("/api/transactions", requireAuthApi, async (req, res) => {
  try {
    const monthKey = parseMonthKey(
      req.query.month ? String(req.query.month) : undefined,
    );
    await syncSubscriptionTransactionsSafely(req.user!.id);
    const transactions = await fetchTransactions(req.user!.id, monthKey);
    res.json({ monthKey, items: transactions });
  } catch (error) {
    console.error("取引一覧の取得に失敗:", error);
    res.status(500).json({ message: "取引一覧の取得に失敗しました。" });
  }
});

app.post("/api/transactions", requireAuthApi, async (req, res) => {
  try {
    const occurredAt = parseDateInput(req.body.occurredAt);
    if (!occurredAt) {
      res.status(400).json({ message: "日付を入力してください。" });
      return;
    }
    const transaction = await db.createTransaction(req.user!.id, {
      ...buildTransactionData(req.body),
      occurredAt,
    });
    res.status(201).json({ transaction: transactionToView(transaction) });
  } catch (error) {
    console.error("取引の保存に失敗:", error);
    res.status(500).json({ message: "取引の保存に失敗しました。" });
  }
});

app.put("/api/transactions/:id", requireAuthApi, async (req, res) => {
  try {
    const id = clampInt(req.params.id);
    const occurredAt = parseDateInput(req.body.occurredAt);
    if (!occurredAt) {
      res.status(400).json({ message: "日付を入力してください。" });
      return;
    }
    const transaction = await db.updateTransaction(req.user!.id, id, {
      ...buildTransactionData(req.body),
      occurredAt,
    });
    if (!transaction) {
      res.status(404).json({ message: "取引が見つかりません。" });
      return;
    }
    res.json({ transaction: transactionToView(transaction) });
  } catch (error) {
    console.error("取引の更新に失敗:", error);
    res.status(500).json({ message: "取引の更新に失敗しました。" });
  }
});

app.delete("/api/transactions/:id", requireAuthApi, async (req, res) => {
  try {
    await db.deleteTransaction(req.user!.id, clampInt(req.params.id));
    res.status(204).end();
  } catch (error) {
    console.error("取引の削除に失敗:", error);
    res.status(500).json({ message: "取引の削除に失敗しました。" });
  }
});

// ---------------- 分析 ----------------

app.get("/api/analytics/summary", requireAuthApi, async (req, res) => {
  try {
    const monthKey = parseMonthKey(String(req.query.month ?? ""));
    await syncSubscriptionTransactionsSafely(req.user!.id);
    const summary = await buildMonthSummary(req.user!.id, monthKey);
    res.json(summary);
  } catch (error) {
    console.error("月次分析の取得に失敗:", error);
    res.status(500).json({ message: "月次分析の取得に失敗しました。" });
  }
});

app.get("/api/analytics/monthly", requireAuthApi, async (req, res) => {
  try {
    const year = Number.parseInt(
      String(req.query.year || new Date().getUTCFullYear()),
      10,
    );
    await syncSubscriptionTransactionsSafely(req.user!.id);
    const graph = await getYearlyGraphData(req.user!.id, year);
    res.json({ year, items: graph });
  } catch (error) {
    console.error("月次グラフの取得に失敗:", error);
    res.status(500).json({ message: "月次グラフの取得に失敗しました。" });
  }
});

app.get("/api/analytics/savings", requireAuthApi, async (req, res) => {
  try {
    const monthKey = parseMonthKey(String(req.query.month ?? ""));
    const savingsGoal = req.user!.savingsGoalAmount ?? 0;
    await syncSubscriptionTransactionsSafely(req.user!.id);
    const savings = await buildSavingsAnalytics(
      req.user!.id,
      monthKey,
      savingsGoal,
    );
    res.json(savings);
  } catch (error) {
    console.error("貯蓄分析の取得に失敗:", error);
    res.status(500).json({ message: "貯蓄分析の取得に失敗しました。" });
  }
});

app.get("/api/analytics/budget-insights", requireAuthApi, async (req, res) => {
  try {
    const monthKey = parseMonthKey(String(req.query.month ?? ""));
    await syncSubscriptionTransactions(req.user!.id);
    const insights = await buildBudgetInsights(req.user!.id, monthKey);
    res.json(insights);
  } catch (error) {
    console.error("予算インサイトの取得に失敗:", error);
    res.status(500).json({ message: "予算インサイトの取得に失敗しました。" });
  }
});

app.get("/api/calendar", requireAuthApi, async (req, res) => {
  try {
    const monthKey = parseMonthKey(String(req.query.month ?? ""));
    await syncSubscriptionTransactions(req.user!.id);
    const summary = await buildMonthSummary(req.user!.id, monthKey);
    res.json({
      monthKey,
      dailyRows: summary.dailyRows,
      totals: summary.totals,
    });
  } catch (error) {
    console.error("カレンダー情報の取得に失敗:", error);
    res.status(500).json({ message: "カレンダー情報の取得に失敗しました。" });
  }
});

// ---------------- 割り勘 ----------------

app.get("/api/split-sessions", requireAuthApi, async (req, res) => {
  try {
    const monthKey = parseMonthKey(String(req.query.month ?? ""));
    const sessions = await db.listSplitSessions(req.user!.id, {
      gte: startOfMonthUtc(monthKey),
      lt: endOfMonthUtc(monthKey),
    });
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
    console.error("割り勘記録の取得に失敗:", error);
    res.status(500).json({ message: "割り勘記録の取得に失敗しました。" });
  }
});

app.post("/api/split-sessions", requireAuthApi, async (req, res) => {
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
    const session = await db.createSplitSession(req.user!.id, {
      title: parsed.title,
      totalAmount: result.totalAmount,
      participantsText: JSON.stringify(parsed.participants),
      contributionsText: JSON.stringify(parsed.payments),
      resultText: JSON.stringify(result.transfers),
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
    console.error("割り勘計算の保存に失敗:", error);
    res.status(500).json({ message: "割り勘計算の保存に失敗しました。" });
  }
});

app.put("/api/split-sessions/:id", requireAuthApi, async (req, res) => {
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
    const session = await db.updateSplitSession(req.user!.id, id, {
      title: parsed.title,
      totalAmount: result.totalAmount,
      participantsText: JSON.stringify(parsed.participants),
      contributionsText: JSON.stringify(parsed.payments),
      resultText: JSON.stringify(result.transfers),
    });
    if (!session) {
      res.status(404).json({ message: "割り勘記録が見つかりません。" });
      return;
    }
    res.json({
      session: {
        ...session,
        participants: parsed.participants,
        payments: parsed.payments,
        result: result.transfers,
      },
    });
  } catch (error) {
    console.error("割り勘記録の更新に失敗:", error);
    res.status(500).json({ message: "割り勘記録の更新に失敗しました。" });
  }
});

app.delete("/api/split-sessions/:id", requireAuthApi, async (req, res) => {
  try {
    await db.deleteSplitSession(req.user!.id, clampInt(req.params.id));
    res.status(204).end();
  } catch (error) {
    console.error("割り勘記録の削除に失敗:", error);
    res.status(500).json({ message: "割り勘記録の削除に失敗しました。" });
  }
});

// ---------------- カテゴリー ----------------

app.get("/api/categories", requireAuthApi, async (req, res) => {
  try {
    const kind =
      req.query.kind === "INCOME" || req.query.kind === "EXPENSE"
        ? req.query.kind
        : undefined;
    const categories = await db.listCategories(req.user!.id, kind);
    res.json({ items: categories });
  } catch (error) {
    console.error("カテゴリー一覧の取得に失敗:", error);
    res.status(500).json({ message: "カテゴリー一覧の取得に失敗しました。" });
  }
});

app.post("/api/categories", requireAuthApi, async (req, res) => {
  try {
    const name = String(req.body.name || "").trim();
    const kind = parseEnumValue(req.body.kind, transactionKinds, "EXPENSE");
    if (!name) {
      res.status(400).json({ message: "カテゴリー名を入力してください。" });
      return;
    }
    const maxOrder = await db.maxCategorySortOrder(req.user!.id, kind);
    const category = await db.createCategory(
      req.user!.id,
      name,
      kind,
      maxOrder + 1,
    );
    res.status(201).json({ category });
  } catch (error) {
    console.error("カテゴリーの追加に失敗:", error);
    res.status(500).json({ message: "カテゴリーの追加に失敗しました。" });
  }
});

app.put("/api/categories/:id", requireAuthApi, async (req, res) => {
  try {
    const name = String(req.body.name || "").trim();
    if (!name) {
      res.status(400).json({ message: "カテゴリー名を入力してください。" });
      return;
    }
    const category = await db.updateCategory(
      req.user!.id,
      clampInt(req.params.id),
      name,
    );
    if (!category) {
      res.status(404).json({ message: "カテゴリーが見つかりません。" });
      return;
    }
    res.json({ category });
  } catch (error) {
    console.error("カテゴリーの更新に失敗:", error);
    res.status(500).json({ message: "カテゴリーの更新に失敗しました。" });
  }
});

app.delete("/api/categories/:id", requireAuthApi, async (req, res) => {
  try {
    await db.deleteCategory(req.user!.id, clampInt(req.params.id));
    res.status(204).end();
  } catch (error) {
    console.error("カテゴリーの削除に失敗:", error);
    res.status(500).json({ message: "カテゴリーの削除に失敗しました。" });
  }
});

// ---------------- 支払い方法 ----------------

app.get("/api/payment-methods", requireAuthApi, async (req, res) => {
  try {
    const items = await db.listPaymentMethods(req.user!.id);
    res.json({ items });
  } catch (error) {
    console.error("支払い方法一覧の取得に失敗:", error);
    res.status(500).json({ message: "支払い方法一覧の取得に失敗しました。" });
  }
});

app.post("/api/payment-methods", requireAuthApi, async (req, res) => {
  try {
    const name = String(req.body.name || "").trim();
    if (!name) {
      res.status(400).json({ message: "支払い方法の名前を入力してください。" });
      return;
    }
    const maxOrder = await db.maxPaymentMethodSortOrder(req.user!.id);
    const method = await db.createPaymentMethod(
      req.user!.id,
      name,
      maxOrder + 1,
    );
    res.status(201).json({ method });
  } catch (error) {
    console.error("支払い方法の追加に失敗:", error);
    res.status(500).json({ message: "支払い方法の追加に失敗しました。" });
  }
});

app.put("/api/payment-methods/:id", requireAuthApi, async (req, res) => {
  try {
    const name = String(req.body.name || "").trim();
    if (!name) {
      res.status(400).json({ message: "支払い方法の名前を入力してください。" });
      return;
    }
    const method = await db.updatePaymentMethod(
      req.user!.id,
      clampInt(req.params.id),
      name,
    );
    if (!method) {
      res.status(404).json({ message: "支払い方法が見つかりません。" });
      return;
    }
    res.json({ method });
  } catch (error) {
    console.error("支払い方法の更新に失敗:", error);
    res.status(500).json({ message: "支払い方法の更新に失敗しました。" });
  }
});

app.delete("/api/payment-methods/:id", requireAuthApi, async (req, res) => {
  try {
    await db.deletePaymentMethod(req.user!.id, clampInt(req.params.id));
    res.status(204).end();
  } catch (error) {
    console.error("支払い方法の削除に失敗:", error);
    res.status(500).json({ message: "支払い方法の削除に失敗しました。" });
  }
});

// ---------------- サブスク ----------------

app.get("/api/subscriptions", requireAuthApi, async (req, res) => {
  try {
    const items = await db.listSubscriptions(req.user!.id);
    res.json({
      items: items.map((item) => ({
        ...item,
        amountLabel: formatCurrency(item.amount),
        intervalLabel:
          item.intervalUnit === "DAY"
            ? `${item.intervalValue}日ごと`
            : `${item.intervalValue}ヶ月ごと`,
        firstPaymentDateLabel: item.firstPaymentDate ?? "未設定",
        statusLabel: item.active ? "稼働中" : "停止中",
      })),
    });
  } catch (error) {
    console.error("サブスク一覧の取得に失敗:", error);
    res.status(500).json({ message: "サブスク一覧の取得に失敗しました。" });
  }
});

function buildSubscriptionData(body: any): db.SubscriptionInput {
  const parsedFirstPaymentDate = parseDateInput(
    String(body.firstPaymentDate || ""),
  );
  const firstPaymentDate = parsedFirstPaymentDate
    ? toIsoDate(parsedFirstPaymentDate)
    : null;
  const intervalUnit =
    String(body.intervalUnit || "MONTH").toUpperCase() === "DAY"
      ? "DAY"
      : "MONTH";
  const intervalValue = Math.max(1, clampInt(body.intervalValue, 1));
  return {
    name: String(body.name || "").trim() || "名称未設定",
    amount: clampInt(body.amount),
    category: String(body.category || "未分類"),
    paymentMethod: String(body.paymentMethod || "その他").trim() || "その他",
    intervalValue,
    intervalUnit,
    firstPaymentDate,
    billingDay: firstPaymentDate ? Number(firstPaymentDate.slice(-2)) : 1,
    memo: String(body.memo || "").trim() || null,
  };
}

app.post("/api/subscriptions", requireAuthApi, async (req, res) => {
  try {
    const subscription = await db.createSubscription(
      req.user!.id,
      buildSubscriptionData(req.body),
    );
    res.status(201).json({
      subscription: {
        ...subscription,
        amountLabel: formatCurrency(subscription.amount),
        intervalLabel:
          subscription.intervalUnit === "DAY"
            ? `${subscription.intervalValue}日ごと`
            : `${subscription.intervalValue}ヶ月ごと`,
        firstPaymentDateLabel: subscription.firstPaymentDate ?? "未設定",
        statusLabel: subscription.active ? "稼働中" : "停止中",
      },
    });
  } catch (error) {
    console.error("サブスクの保存に失敗:", error);
    res.status(500).json({ message: "サブスクの保存に失敗しました。" });
  }
});

app.put("/api/subscriptions/:id", requireAuthApi, async (req, res) => {
  try {
    const subscription = await db.updateSubscription(
      req.user!.id,
      clampInt(req.params.id),
      buildSubscriptionData(req.body),
    );
    if (!subscription) {
      res.status(404).json({ message: "サブスクが見つかりません。" });
      return;
    }
    res.json({
      subscription: {
        ...subscription,
        amountLabel: formatCurrency(subscription.amount),
        intervalLabel:
          subscription.intervalUnit === "DAY"
            ? `${subscription.intervalValue}日ごと`
            : `${subscription.intervalValue}ヶ月ごと`,
        firstPaymentDateLabel: subscription.firstPaymentDate ?? "未設定",
        statusLabel: subscription.active ? "稼働中" : "停止中",
      },
    });
  } catch (error) {
    console.error("サブスクの更新に失敗:", error);
    res.status(500).json({ message: "サブスクの更新に失敗しました。" });
  }
});

app.post("/api/subscriptions/:id/stop", requireAuthApi, async (req, res) => {
  try {
    const subscription = await db.stopSubscription(
      req.user!.id,
      clampInt(req.params.id),
    );
    if (!subscription) {
      res.status(404).json({ message: "サブスクが見つかりません。" });
      return;
    }
    res.json({
      subscription: {
        ...subscription,
        amountLabel: formatCurrency(subscription.amount),
        intervalLabel:
          subscription.intervalUnit === "DAY"
            ? `${subscription.intervalValue}日ごと`
            : `${subscription.intervalValue}ヶ月ごと`,
        firstPaymentDateLabel: subscription.firstPaymentDate ?? "未設定",
        statusLabel: subscription.active ? "稼働中" : "停止中",
      },
    });
  } catch (error) {
    console.error("サブスクの停止に失敗:", error);
    res.status(500).json({ message: "サブスクの停止に失敗しました。" });
  }
});

app.post("/api/subscriptions/:id/resume", requireAuthApi, async (req, res) => {
  try {
    const subscription = await db.resumeSubscription(
      req.user!.id,
      clampInt(req.params.id),
    );
    if (!subscription) {
      res.status(404).json({ message: "サブスクが見つかりません。" });
      return;
    }
    // 再開直後に、今日時点までの発生日を反映させる（停止していた期間は paused_ranges により自動で除外される）
    await syncSubscriptionTransactions(req.user!.id);
    res.json({
      subscription: {
        ...subscription,
        amountLabel: formatCurrency(subscription.amount),
        intervalLabel:
          subscription.intervalUnit === "DAY"
            ? `${subscription.intervalValue}日ごと`
            : `${subscription.intervalValue}ヶ月ごと`,
        firstPaymentDateLabel: subscription.firstPaymentDate ?? "未設定",
        statusLabel: subscription.active ? "稼働中" : "停止中",
      },
    });
  } catch (error) {
    console.error("サブスクの再開に失敗:", error);
    res.status(500).json({ message: "サブスクの再開に失敗しました。" });
  }
});

app.delete("/api/subscriptions/:id", requireAuthApi, async (req, res) => {
  try {
    await db.deleteSubscription(req.user!.id, clampInt(req.params.id));
    res.status(204).end();
  } catch (error) {
    console.error("サブスクの削除に失敗:", error);
    res.status(500).json({ message: "サブスクの削除に失敗しました。" });
  }
});

// ---------------- 月予算 ----------------

app.get("/api/budgets", requireAuthApi, async (req, res) => {
  try {
    const monthKey = parseMonthKey(String(req.query.month ?? ""));
    const items = await db.listBudgets(req.user!.id, monthKey);
    res.json({ monthKey, items });
  } catch (error) {
    console.error("予算の取得に失敗:", error);
    res.status(500).json({ message: "予算の取得に失敗しました。" });
  }
});

app.put("/api/budgets", requireAuthApi, async (req, res) => {
  try {
    const monthKey = parseMonthKey(String(req.body.month ?? ""));
    const category = String(req.body.category || "").trim();
    if (!category) {
      res.status(400).json({ message: "カテゴリーを指定してください。" });
      return;
    }
    const rawAmount = req.body.amount;
    if (rawAmount === null || rawAmount === "" || rawAmount === undefined) {
      await db.deleteBudget(req.user!.id, monthKey, category);
      res.json({ ok: true });
      return;
    }
    const amount = Math.max(0, clampInt(rawAmount, 0));
    const budget = await db.upsertBudget(
      req.user!.id,
      monthKey,
      category,
      amount,
    );
    res.json({ budget });
  } catch (error) {
    console.error("予算の保存に失敗:", error);
    res.status(500).json({ message: "予算の保存に失敗しました。" });
  }
});

// ---------------- 起動 ----------------

async function start() {
  try {
    const migrationSql = fs.readFileSync(
      path.join(__dirname, "sql", "schema.sql"),
      "utf8",
    );
    await db.runMigrations(migrationSql);
  } catch (error) {
    console.error("マイグレーションに失敗:", error);
  }

  await syncAllSubscriptionTransactionsSafely();
  setInterval(
    () => {
      void syncAllSubscriptionTransactionsSafely();
    },
    15 * 60 * 1000,
  );

  app.listen(PORT, () => {
    console.log(`サーバーが動いたぞ！ http://localhost:${PORT}`);
  });
}

start();

async function shutdown() {
  await db.pool.end();
}

process.on("SIGINT", async () => {
  await shutdown();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  await shutdown();
  process.exit(0);
});
