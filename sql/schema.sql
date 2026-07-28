-- MoneyPilot: 手書きの自動マイグレーション（起動時に毎回実行、すべて IF NOT EXISTS）
-- Prisma Client の再生成が難しい環境でも動かせるように、pg プールで直接SQLを発行する構成にしています。
-- schema.prisma は将来 `npx prisma db push` / `db pull` する際の参照用として残しています。

CREATE TABLE IF NOT EXISTS users (
  id                  SERIAL PRIMARY KEY,
  username            TEXT UNIQUE NOT NULL,
  email               TEXT UNIQUE NOT NULL,
  password_hash       TEXT NOT NULL,
  savings_goal_amount INTEGER,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 旧バージョン（PIN・分析タブ表示切替）からのアップグレード用。存在しない環境でもエラーになりません。
ALTER TABLE users ADD COLUMN IF NOT EXISTS email TEXT;
ALTER TABLE users DROP COLUMN IF EXISTS pin_hash;
ALTER TABLE users DROP COLUMN IF EXISTS pin_enabled;
ALTER TABLE users DROP COLUMN IF EXISTS analytics_enabled;

CREATE UNIQUE INDEX IF NOT EXISTS users_email_key ON users(email);

-- メール認証コード（新規登録・パスワード再設定の両方で使用）
CREATE TABLE IF NOT EXISTS email_verifications (
  id          SERIAL PRIMARY KEY,
  email       TEXT NOT NULL,
  purpose     TEXT NOT NULL, -- 'register' | 'reset'
  code_hash   TEXT NOT NULL,
  attempts    INTEGER NOT NULL DEFAULT 0,
  expires_at  TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS email_verifications_lookup_idx ON email_verifications(email, purpose, created_at DESC);

CREATE TABLE IF NOT EXISTS webauthn_credentials (
  id                 SERIAL PRIMARY KEY,
  user_id            INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  credential_id      TEXT UNIQUE NOT NULL,
  device_secret_hash TEXT UNIQUE NOT NULL,
  label              TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS categories (
  id         SERIAL PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS transactions (
  id                SERIAL PRIMARY KEY,
  user_id           INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind              TEXT NOT NULL,
  amount            INTEGER NOT NULL,
  occurred_at       TIMESTAMPTZ NOT NULL,
  category          TEXT NOT NULL,
  payment_method    TEXT NOT NULL,
  satisfaction      TEXT NOT NULL DEFAULT 'NORMAL',
  spending_style    TEXT NOT NULL DEFAULT 'CONSUMPTION',
  memo              TEXT,
  receipt_image_url TEXT,
  receipt_text      TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS transactions_user_id_idx ON transactions(user_id);

CREATE TABLE IF NOT EXISTS split_settlements (
  id                  SERIAL PRIMARY KEY,
  user_id             INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title               TEXT NOT NULL,
  total_amount        INTEGER NOT NULL,
  participants_text   TEXT NOT NULL,
  contributions_text  TEXT NOT NULL,
  result_text         TEXT NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS split_settlements_user_id_idx ON split_settlements(user_id);
