# 家計簿アプリ（MoneyPilot）

Express + PostgreSQL（生SQL） + EJS で動く、家計簿・割り勘・分析・カレンダーのアプリです。
ユーザー登録制になっており、各ユーザーの記録は他のユーザーから見えません。

## 起動手順

```bash
npm install
npm start
```

サーバー起動時に `sql/schema.sql` を自動実行し、必要なテーブルがなければ作成します
（`CREATE TABLE IF NOT EXISTS` のみなので、既存データがあっても壊しません）。
`.env` の `DATABASE_URL` が指す PostgreSQL に接続できる状態で起動してください。

`.env` には `SESSION_SECRET`（ログインセッションの署名用ランダム文字列）も必要です。
このリポジトリには開発用にランダム生成した値を入れていますが、本番環境では
Render の環境変数などで別の値に差し替えることをおすすめします。

## 今回の変更点

1. **レイアウト調整**
   - グラフ・カレンダーを2カラムのグリッドから外し、全幅で大きく表示するようにしました。
   - 円グラフは「グラフ→凡例」を横並びではなく縦に並べる形にし、支出／収入の2つの円グラフの
     位置がずれる問題を解消しました。
   - 画面の高さいっぱいに固定表示にし、「収支記録」タブの記録一覧だけが内部スクロールする
     ようにしました（それ以外のタブは内容量によっては画面全体がスクロールします）。
   - 画面幅で崩れないよう、レスポンシブ対応（`@media`）をやめて幅1280pxの固定レイアウトに
     しています。**1280px未満の画面では横スクロールが発生します。** スマホでの利用が多い場合は
     別途モバイル向けレイアウトの検討をおすすめします。

2. **ユーザー登録・ログイン・データの分離**
   - `users` テーブルを追加し、取引・カテゴリー・割り勘記録すべてに `user_id` を付与しました。
   - パスワードは Node標準の `crypto.scrypt` でハッシュ化して保存しています（平文保存なし）。
   - `/login` でログイン・新規登録ができます。未ログインで `/` にアクセスすると `/login` に
     リダイレクトされます。

3. **PINコードログイン**
   - 設定画面から4〜8桁のPINを設定できます。ログイン画面の「PIN」タブから、ユーザー名＋PIN
     でもログインできます。

4. **Face ID・指紋（生体認証）ログイン**
   - ⚠️ この開発環境ではネットワークが使えず、FIDO2の署名検証ライブラリ
     （`@simplewebauthn/server` など）を追加インストールできませんでした。そのため、
     「端末に保存した高強度ランダムトークン（httpOnly cookie）を、ブラウザのWebAuthn生体認証
     プロンプトでゲートする」という実用的な簡易実装にしています。
     - 端末側の突破口（cookieの値）を持っていない限りログインはできないため、実用上の安全性は
       確保しつつ、Face ID・指紋・画面ロック等でサッと再ログインできる体験を実現しています。
     - より厳密なFIDO2準拠（署名の暗号検証）にしたい場合は、ネットワークが使える環境で
       `npm install @simplewebauthn/server` を行い、`/api/auth/webauthn/*` の実装を
       差し替えることをおすすめします。

5. **設定画面（ハンバーガーメニュー）**
   - 画面左上の三本線アイコンから開きます。
   - 「分析」タブの表示・非表示切り替え、貯蓄目標額の設定（空欄でOK）、PINの設定・削除、
     生体認証端末の登録・削除、ログアウトができます。

## この環境での制約について

この開発サンドボックスはネットワークアクセスがなく、`npm install` で新しいパッケージを
追加したり、実際のPostgreSQLに接続してアプリを動作確認したりすることができませんでした。
そのため：

- Prisma Client の再生成（`prisma generate`）ができなかったため、DBアクセスは
  Prisma Client を経由せず、`pg` パッケージで直接SQLを発行する構成に変更しました
  （`lib/db.ts`）。`prisma/schema.prisma` は将来 `npx prisma db push` 等を使う場合の
  参照用として残しています。
- コードの構文チェック・EJSテンプレートのレンダリングチェックは行いましたが、
  実際のPostgreSQLに接続しての動作確認はできていません。**デプロイ前に、ご自身の環境
  （ネットワークがつながる場所）で一度動作確認をお願いします。**
  Claude Code などネットワークが使える環境で `npm install && npm start` すると、
  起動時に自動でテーブルが作成されます。

## 主な機能

- ユーザーごとの家計簿（登録・ログイン・PIN・生体認証）
- 支出・収入の記録と一覧表示
- 満足度と投資・消費・浪費の分類保存
- 月次収支グラフの自動生成（全幅表示）
- 月次分析と円グラフ表示（全幅表示）
- 割り勘の精算計算と保存
- 日別カレンダー表示（全幅表示）
- 設定画面（分析タブの表示切替、貯蓄目標額、PIN、生体認証端末管理）

## 主なAPI

- `POST /api/auth/register` / `POST /api/auth/login` / `POST /api/auth/login-pin` / `POST /api/auth/logout`
- `POST /api/auth/pin` / `DELETE /api/auth/pin`
- `POST /api/auth/webauthn/register` / `POST /api/auth/webauthn/login`
- `PUT /api/settings`
- `GET/POST/PUT/DELETE /api/transactions`
- `GET /api/analytics/summary` / `GET /api/analytics/monthly` / `GET /api/analytics/savings`
- `GET /api/calendar`
- `GET/POST/PUT/DELETE /api/split-sessions`
- `GET/POST/PUT/DELETE /api/categories`
