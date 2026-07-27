import pg from "pg";

export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL!,
});

export async function runMigrations(sql: string) {
  await pool.query(sql);
}

// ---------- 型 ----------

export type UserRow = {
  id: number;
  username: string;
  passwordHash: string;
  pinHash: string | null;
  pinEnabled: boolean;
  analyticsEnabled: boolean;
  savingsGoalAmount: number | null;
  createdAt: Date;
  updatedAt: Date;
};

export type TransactionRow = {
  id: number;
  userId: number;
  kind: "INCOME" | "EXPENSE";
  amount: number;
  occurredAt: Date;
  category: string;
  paymentMethod: string;
  satisfaction: string;
  spendingStyle: string;
  memo: string | null;
  receiptImageUrl: string | null;
  receiptText: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type SplitSettlementRow = {
  id: number;
  userId: number;
  title: string;
  totalAmount: number;
  participantsText: string;
  contributionsText: string;
  resultText: string;
  createdAt: Date;
  updatedAt: Date;
};

export type CategoryRow = {
  id: number;
  userId: number;
  name: string;
  sortOrder: number;
  createdAt: Date;
};

export type WebauthnCredentialRow = {
  id: number;
  userId: number;
  credentialId: string;
  deviceSecretHash: string;
  label: string | null;
  createdAt: Date;
  lastUsedAt: Date;
};

function mapUser(row: any): UserRow {
  return {
    id: row.id,
    username: row.username,
    passwordHash: row.password_hash,
    pinHash: row.pin_hash,
    pinEnabled: row.pin_enabled,
    analyticsEnabled: row.analytics_enabled,
    savingsGoalAmount:
      row.savings_goal_amount === null ? null : Number(row.savings_goal_amount),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapTransaction(row: any): TransactionRow {
  return {
    id: row.id,
    userId: row.user_id,
    kind: row.kind,
    amount: Number(row.amount),
    occurredAt: row.occurred_at,
    category: row.category,
    paymentMethod: row.payment_method,
    satisfaction: row.satisfaction,
    spendingStyle: row.spending_style,
    memo: row.memo,
    receiptImageUrl: row.receipt_image_url,
    receiptText: row.receipt_text,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapSplit(row: any): SplitSettlementRow {
  return {
    id: row.id,
    userId: row.user_id,
    title: row.title,
    totalAmount: Number(row.total_amount),
    participantsText: row.participants_text,
    contributionsText: row.contributions_text,
    resultText: row.result_text,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapCategory(row: any): CategoryRow {
  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    sortOrder: row.sort_order,
    createdAt: row.created_at,
  };
}

function mapCredential(row: any): WebauthnCredentialRow {
  return {
    id: row.id,
    userId: row.user_id,
    credentialId: row.credential_id,
    deviceSecretHash: row.device_secret_hash,
    label: row.label,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
  };
}

// ---------- users ----------

export async function findUserByUsername(
  username: string,
): Promise<UserRow | null> {
  const { rows } = await pool.query("SELECT * FROM users WHERE username = $1", [
    username,
  ]);
  return rows[0] ? mapUser(rows[0]) : null;
}

export async function findUserById(id: number): Promise<UserRow | null> {
  const { rows } = await pool.query("SELECT * FROM users WHERE id = $1", [id]);
  return rows[0] ? mapUser(rows[0]) : null;
}

export async function createUser(
  username: string,
  passwordHash: string,
): Promise<UserRow> {
  const { rows } = await pool.query(
    "INSERT INTO users (username, password_hash) VALUES ($1, $2) RETURNING *",
    [username, passwordHash],
  );
  return mapUser(rows[0]);
}

export async function updateUserPin(
  userId: number,
  pinHash: string | null,
  pinEnabled: boolean,
) {
  await pool.query(
    "UPDATE users SET pin_hash = $2, pin_enabled = $3, updated_at = now() WHERE id = $1",
    [userId, pinHash, pinEnabled],
  );
}

export async function updateUserSettings(
  userId: number,
  settings: { analyticsEnabled?: boolean; savingsGoalAmount?: number | null },
) {
  const fields: string[] = [];
  const values: unknown[] = [userId];

  if (settings.analyticsEnabled !== undefined) {
    values.push(settings.analyticsEnabled);
    fields.push(`analytics_enabled = $${values.length}`);
  }
  if (settings.savingsGoalAmount !== undefined) {
    values.push(settings.savingsGoalAmount);
    fields.push(`savings_goal_amount = $${values.length}`);
  }
  if (fields.length === 0) return;

  await pool.query(
    `UPDATE users SET ${fields.join(", ")}, updated_at = now() WHERE id = $1`,
    values,
  );
}

// ---------- webauthn credentials ----------

export async function createWebauthnCredential(
  userId: number,
  credentialId: string,
  deviceSecretHash: string,
  label: string | null,
): Promise<WebauthnCredentialRow> {
  const { rows } = await pool.query(
    `INSERT INTO webauthn_credentials (user_id, credential_id, device_secret_hash, label)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [userId, credentialId, deviceSecretHash, label],
  );
  return mapCredential(rows[0]);
}

export async function findCredentialByDeviceSecretHash(
  hash: string,
): Promise<WebauthnCredentialRow | null> {
  const { rows } = await pool.query(
    "SELECT * FROM webauthn_credentials WHERE device_secret_hash = $1",
    [hash],
  );
  return rows[0] ? mapCredential(rows[0]) : null;
}

export async function listCredentialsForUser(
  userId: number,
): Promise<WebauthnCredentialRow[]> {
  const { rows } = await pool.query(
    "SELECT * FROM webauthn_credentials WHERE user_id = $1 ORDER BY created_at DESC",
    [userId],
  );
  return rows.map(mapCredential);
}

export async function touchCredential(id: number) {
  await pool.query(
    "UPDATE webauthn_credentials SET last_used_at = now() WHERE id = $1",
    [id],
  );
}

export async function deleteCredential(userId: number, id: number) {
  await pool.query(
    "DELETE FROM webauthn_credentials WHERE id = $1 AND user_id = $2",
    [id, userId],
  );
}

// ---------- categories ----------

export async function listCategories(userId: number): Promise<CategoryRow[]> {
  const { rows } = await pool.query(
    "SELECT * FROM categories WHERE user_id = $1 ORDER BY sort_order ASC, id ASC",
    [userId],
  );
  return rows.map(mapCategory);
}

export async function countCategories(userId: number): Promise<number> {
  const { rows } = await pool.query(
    "SELECT COUNT(*)::int AS c FROM categories WHERE user_id = $1",
    [userId],
  );
  return rows[0].c;
}

export async function createDefaultCategories(userId: number, names: string[]) {
  for (let i = 0; i < names.length; i += 1) {
    await pool.query(
      "INSERT INTO categories (user_id, name, sort_order) VALUES ($1, $2, $3)",
      [userId, names[i], i],
    );
  }
}

export async function createCategory(
  userId: number,
  name: string,
  sortOrder: number,
): Promise<CategoryRow> {
  const { rows } = await pool.query(
    "INSERT INTO categories (user_id, name, sort_order) VALUES ($1, $2, $3) RETURNING *",
    [userId, name, sortOrder],
  );
  return mapCategory(rows[0]);
}

export async function updateCategory(
  userId: number,
  id: number,
  name: string,
): Promise<CategoryRow | null> {
  const { rows } = await pool.query(
    "UPDATE categories SET name = $3 WHERE id = $1 AND user_id = $2 RETURNING *",
    [id, userId, name],
  );
  return rows[0] ? mapCategory(rows[0]) : null;
}

export async function deleteCategory(userId: number, id: number) {
  await pool.query("DELETE FROM categories WHERE id = $1 AND user_id = $2", [
    id,
    userId,
  ]);
}

export async function maxCategorySortOrder(userId: number): Promise<number> {
  const { rows } = await pool.query(
    "SELECT MAX(sort_order) AS m FROM categories WHERE user_id = $1",
    [userId],
  );
  return rows[0].m === null ? -1 : Number(rows[0].m);
}

// ---------- transactions ----------

export type TransactionInput = {
  kind: "INCOME" | "EXPENSE";
  amount: number;
  occurredAt: Date;
  category: string;
  paymentMethod: string;
  satisfaction: string;
  spendingStyle: string;
  memo: string | null;
};

export async function listTransactions(
  userId: number,
  range?: { gte: Date; lt: Date },
): Promise<TransactionRow[]> {
  if (range) {
    const { rows } = await pool.query(
      `SELECT * FROM transactions WHERE user_id = $1 AND occurred_at >= $2 AND occurred_at < $3
       ORDER BY occurred_at DESC`,
      [userId, range.gte, range.lt],
    );
    return rows.map(mapTransaction);
  }
  const { rows } = await pool.query(
    "SELECT * FROM transactions WHERE user_id = $1 ORDER BY occurred_at DESC",
    [userId],
  );
  return rows.map(mapTransaction);
}

export async function createTransaction(
  userId: number,
  data: TransactionInput,
): Promise<TransactionRow> {
  const { rows } = await pool.query(
    `INSERT INTO transactions
      (user_id, kind, amount, occurred_at, category, payment_method, satisfaction, spending_style, memo)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
    [
      userId,
      data.kind,
      data.amount,
      data.occurredAt,
      data.category,
      data.paymentMethod,
      data.satisfaction,
      data.spendingStyle,
      data.memo,
    ],
  );
  return mapTransaction(rows[0]);
}

export async function updateTransaction(
  userId: number,
  id: number,
  data: TransactionInput,
): Promise<TransactionRow | null> {
  const { rows } = await pool.query(
    `UPDATE transactions SET
      kind = $3, amount = $4, occurred_at = $5, category = $6, payment_method = $7,
      satisfaction = $8, spending_style = $9, memo = $10, updated_at = now()
     WHERE id = $1 AND user_id = $2 RETURNING *`,
    [
      id,
      userId,
      data.kind,
      data.amount,
      data.occurredAt,
      data.category,
      data.paymentMethod,
      data.satisfaction,
      data.spendingStyle,
      data.memo,
    ],
  );
  return rows[0] ? mapTransaction(rows[0]) : null;
}

export async function deleteTransaction(userId: number, id: number) {
  await pool.query("DELETE FROM transactions WHERE id = $1 AND user_id = $2", [
    id,
    userId,
  ]);
}

export async function sumTransactions(
  userId: number,
  kind: "INCOME" | "EXPENSE",
  range?: { gte: Date; lt: Date },
): Promise<number> {
  if (range) {
    const { rows } = await pool.query(
      `SELECT COALESCE(SUM(amount), 0) AS s FROM transactions
       WHERE user_id = $1 AND kind = $2 AND occurred_at >= $3 AND occurred_at < $4`,
      [userId, kind, range.gte, range.lt],
    );
    return Number(rows[0].s);
  }
  const { rows } = await pool.query(
    "SELECT COALESCE(SUM(amount), 0) AS s FROM transactions WHERE user_id = $1 AND kind = $2",
    [userId, kind],
  );
  return Number(rows[0].s);
}

// ---------- split settlements ----------

export type SplitInput = {
  title: string;
  totalAmount: number;
  participantsText: string;
  contributionsText: string;
  resultText: string;
};

export async function listSplitSessions(
  userId: number,
  range?: { gte: Date; lt: Date },
): Promise<SplitSettlementRow[]> {
  if (range) {
    const { rows } = await pool.query(
      `SELECT * FROM split_settlements WHERE user_id = $1 AND created_at >= $2 AND created_at < $3
       ORDER BY created_at DESC`,
      [userId, range.gte, range.lt],
    );
    return rows.map(mapSplit);
  }
  const { rows } = await pool.query(
    "SELECT * FROM split_settlements WHERE user_id = $1 ORDER BY created_at DESC",
    [userId],
  );
  return rows.map(mapSplit);
}

export async function createSplitSession(
  userId: number,
  data: SplitInput,
): Promise<SplitSettlementRow> {
  const { rows } = await pool.query(
    `INSERT INTO split_settlements (user_id, title, total_amount, participants_text, contributions_text, result_text)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [
      userId,
      data.title,
      data.totalAmount,
      data.participantsText,
      data.contributionsText,
      data.resultText,
    ],
  );
  return mapSplit(rows[0]);
}

export async function updateSplitSession(
  userId: number,
  id: number,
  data: SplitInput,
): Promise<SplitSettlementRow | null> {
  const { rows } = await pool.query(
    `UPDATE split_settlements SET
      title = $3, total_amount = $4, participants_text = $5, contributions_text = $6,
      result_text = $7, updated_at = now()
     WHERE id = $1 AND user_id = $2 RETURNING *`,
    [
      id,
      userId,
      data.title,
      data.totalAmount,
      data.participantsText,
      data.contributionsText,
      data.resultText,
    ],
  );
  return rows[0] ? mapSplit(rows[0]) : null;
}

export async function deleteSplitSession(userId: number, id: number) {
  await pool.query(
    "DELETE FROM split_settlements WHERE id = $1 AND user_id = $2",
    [id, userId],
  );
}
