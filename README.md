# 家計簿アプリ（MoneyPilot）

Express + PostgreSQL（生SQL） + EJS で動く、家計簿・割り勘・分析・カレンダーのアプリです。
ユーザー登録制になっており、各ユーザーの記録は他のユーザーから見えません。

## 起動手順

```bash
npm install
npm start
```

サーバー起動時に `sql/schema.sql` を自動実行し、必要なテーブルがなければ作成・アップグレードします
（`CREATE TABLE IF NOT EXISTS` / `ALTER TABLE ... IF NOT EXISTS` のみなので、既存データがあっても壊しません）。
`.env` の `DATABASE_URL` が指す PostgreSQL に接続できる状態で起動してください。

`.env` には `SESSION_SECRET`（ログインセッションの署名用ランダム文字列）も必要です。
開発用にランダム生成した値を入れていますが、本番環境では別の値に差し替えることをおすすめします。

### メール送信（新規登録・パスワード再設定の認証コード用）

`.env` に `SMTP_HOST` / `SMTP_USER` / `SMTP_PASS` 等を設定すると、nodemailer 経由で実際に
メールを送信します。**未設定の場合は、認証コードがサーバーのコンソールに出力されるだけの
開発用フォールバックになります**（ローカルでの動作確認に便利です）。

```
SMTP_HOST="smtp.example.com"
SMTP_PORT="587"
SMTP_USER="user@example.com"
SMTP_PASS="xxxxxxxx"
MAIL_FROM="MoneyPilot <no-reply@example.com>"
```

## 画面レイアウトについて

配置（縦1カラムの並び順）はスマホでもPCでも常に同じにしたまま、画面の横幅に合わせて
ページ全体を拡大縮小して表示します（`views/index.ejs` の `#scaleRoot` に対する
`transform: scale()`）。画面が広いほど全体が大きく表示され、その分ページ全体が縦に
スクロールする形になります（内部の枠だけがスクロールすることはありません）。

- 基準デザイン幅は560pxです（`BASE_WIDTH` 定数）。
- 極端に大きな画面で文字が巨大化しすぎないよう、拡大率の上限を1.85倍にしています
  （`MAX_SCALE` 定数）。上限をなくしたい・変えたい場合はこの値を調整してください。
- 小さすぎる画面でも見づらくならないよう、縮小率の下限を0.6倍にしています（`MIN_SCALE`）。

## ユーザー登録・ログインについて

- 新規登録は「メールアドレス入力 → 6桁の認証コードをメールで受け取り確認 → ユーザー名・
  パスワードを設定」の3ステップです。以後は、設定したユーザー名とパスワードでログインします。
- パスワードを忘れた場合は、ログイン画面の「パスワードをお忘れですか？」から、登録済みの
  メールアドレスに認証コードを送って再設定できます（このときユーザー名もあわせて画面に表示します）。
- PINコードによるログインは廃止しました。

### Face ID・指紋（生体認証）ログイン

- ⚠️ この開発環境ではネットワークが使えず、FIDO2の署名検証ライブラリ
  （`@simplewebauthn/server` など）を追加インストールできませんでした。そのため、
  「端末に保存した高強度ランダムトークン（httpOnly cookie）を、ブラウザのWebAuthn生体認証
  プロンプトでゲートする」という実用的な簡易実装にしています。
  - 端末側の突破口（cookieの値）を持っていない限りログインはできないため、実用上の安全性は
    確保しつつ、Face ID・指紋・画面ロック等でサッと再ログインできる体験を実現しています。
  - より厳密なFIDO2準拠（署名の暗号検証）にしたい場合は、ネットワークが使える環境で
    `npm install @simplewebauthn/server` を行い、`/api/auth/webauthn/*` の実装を
    差し替えることをおすすめします。
- 設定画面（左上のハンバーガーメニュー）から、端末の登録・削除ができます。

## 設定画面（ハンバーガーメニュー）

画面左上の三本線アイコンから開きます。

- アカウント情報の確認・ログアウト
- 貯蓄目標額の設定（空欄でOK）
- 生体認証端末の登録・削除

「分析」タブの表示・非表示切り替えは廃止し、常に表示するようにしました。

## この環境での制約について

この開発サンドボックスはネットワークアクセスがなく、`npm install` で新しいパッケージ
（`nodemailer` を含む）を追加したり、実際のPostgreSQLやSMTPサーバーに接続して動作確認
したりすることができませんでした。そのため：

- DBアクセスは Prisma Client を経由せず、`pg` パッケージで直接SQLを発行する構成にしています
  （`lib/db.ts`）。`prisma/schema.prisma` は参照用として残しています。
- コードの構文チェック・EJSテンプレートのレンダリングチェックは行いましたが、実際の
  PostgreSQL・SMTPサーバーに接続しての動作確認はできていません。**デプロイ前に、ご自身の
  環境（ネットワークがつながる場所）で一度動作確認をお願いします。**
  Claude Code などネットワークが使える環境で `npm install && npm start` すると、
  起動時に自動でテーブルが作成・アップグレードされます。

## 主な機能

- ユーザーごとの家計簿（メール認証つき登録・ログイン・パスワード再設定・生体認証）
- 支出・収入の記録と一覧表示
- 満足度と投資・消費・浪費の分類保存
- 月次収支グラフの自動生成（全幅表示）
- 月次分析と円グラフ表示（常時表示・全幅表示）
- 割り勘の精算計算と保存
- 日別カレンダー表示（全幅表示）
- 画面サイズに応じて配置そのままに拡大縮小するレイアウト
- 設定画面（貯蓄目標額、生体認証端末管理）

## 主なAPI

- `POST /api/auth/register/request-code` / `POST /api/auth/register/verify-code` / `POST /api/auth/register/complete`
- `POST /api/auth/login` / `POST /api/auth/logout`
- `POST /api/auth/password-reset/request` / `POST /api/auth/password-reset/verify` / `POST /api/auth/password-reset/complete`
- `POST /api/auth/webauthn/register` / `POST /api/auth/webauthn/login`
- `PUT /api/settings`
- `GET/POST/PUT/DELETE /api/transactions`
- `GET /api/analytics/summary` / `GET /api/analytics/monthly` / `GET /api/analytics/savings`
- `GET /api/calendar`
- `GET/POST/PUT/DELETE /api/split-sessions`
- `GET/POST/PUT/DELETE /api/categories`
