# 家計簿アプリ

Express + Prisma + SQLite で動く、家計簿・割り勘・分析・カレンダーの雛形です。

## 起動手順

1. 依存関係を入れます。
2. Prisma のスキーマを SQLite に反映します。
3. Prisma クライアントを生成します。
4. アプリを起動します。

```bash
npm install
npm run db:push
npm run db:generate
npm start
```

## 主な機能

- 支出・収入の記録と一覧表示
- 満足度と投資・消費・浪費の分類保存
- 月次収支グラフの自動生成
- 月次分析と円グラフ表示
- 割り勘の精算計算と保存
- 日別カレンダー表示

## API

- `GET /api/transactions`
- `POST /api/transactions`
- `GET /api/analytics/summary`
- `GET /api/analytics/monthly`
- `GET /api/calendar`
- `GET /api/split-sessions`
- `POST /api/split-sessions`
