// メール送信ユーティリティ。
// SMTP_HOST / SMTP_PORT / SMTP_USER / SMTP_PASS / MAIL_FROM が環境変数にあれば
// nodemailer で実際にメールを送信します。未設定の場合（ローカル開発時など）は
// コンソールにコードを出力するだけのフォールバックになります。
//
// 注意：この開発サンドボックスはネットワークが使えないため nodemailer の動作確認は
// できていません。package.json には追加済みなので、`npm install` 後にご自身の環境で
// 一度テスト送信の確認をお願いします。

type SendArgs = { to: string; subject: string; text: string };

let cachedTransporter: any = null;
let triedLoad = false;

async function getTransporter() {
  if (triedLoad) return cachedTransporter;
  triedLoad = true;

  const host = process.env.SMTP_HOST;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  if (!host || !user || !pass) return null;

  try {
    const nodemailerModule: any = await import("nodemailer");
    const nodemailer = nodemailerModule.default ?? nodemailerModule;
    cachedTransporter = nodemailer.createTransport({
      host,
      port: Number(process.env.SMTP_PORT || 587),
      secure: Number(process.env.SMTP_PORT || 587) === 465,
      auth: { user, pass },
    });
    return cachedTransporter;
  } catch (error) {
    console.error(
      "nodemailerの読み込みに失敗しました。`npm install` を実行してください。以後はコンソール出力にフォールバックします。",
      error,
    );
    return null;
  }
}

export async function sendMail({ to, subject, text }: SendArgs) {
  const transporter = await getTransporter();

  if (!transporter) {
    console.log(
      `\n[メール送信（未設定のためコンソール出力）]\n宛先: ${to}\n件名: ${subject}\n本文:\n${text}\n`,
    );
    return;
  }

  await transporter.sendMail({
    from: process.env.MAIL_FROM || process.env.SMTP_USER,
    to,
    subject,
    text,
  });
}

export function buildVerificationEmail(
  code: string,
  purpose: "register" | "reset",
) {
  if (purpose === "register") {
    return {
      subject: "【MoneyPilot】メール認証コード",
      text: `MoneyPilotのご登録ありがとうございます。\n\n認証コード: ${code}\n\nこのコードは10分間有効です。心当たりがない場合はこのメールを破棄してください。`,
    };
  }
  return {
    subject: "【MoneyPilot】パスワード再設定コード",
    text: `パスワード再設定のリクエストを受け付けました。\n\n認証コード: ${code}\n\nこのコードは10分間有効です。心当たりがない場合はこのメールを破棄してください。`,
  };
}
