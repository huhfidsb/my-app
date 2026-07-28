import crypto from "node:crypto";

const SESSION_SECRET =
  process.env.SESSION_SECRET || "dev-only-insecure-secret-change-me";
const SESSION_COOKIE = "mp_session";
const DEVICE_COOKIE = "mp_device";
const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30日
const DEVICE_MAX_AGE_MS = 365 * 24 * 60 * 60 * 1000; // 1年

// ---------- パスワード / 認証コードのハッシュ化（Node標準crypto の scrypt。追加パッケージ不要） ----------

export function hashSecret(plain: string): string {
  const salt = crypto.randomBytes(16);
  const derived = crypto.scryptSync(plain, salt, 64);
  return `${salt.toString("hex")}:${derived.toString("hex")}`;
}

export function verifySecret(
  plain: string,
  stored: string | null | undefined,
): boolean {
  if (!stored) return false;
  const [saltHex, hashHex] = stored.split(":");
  if (!saltHex || !hashHex) return false;
  try {
    const salt = Buffer.from(saltHex, "hex");
    const expected = Buffer.from(hashHex, "hex");
    const derived = crypto.scryptSync(plain, salt, 64);
    return (
      derived.length === expected.length &&
      crypto.timingSafeEqual(derived, expected)
    );
  } catch {
    return false;
  }
}

// ---------- Cookie の手動パース（cookie-parser 等の追加依存なし） ----------

export function parseCookies(header?: string | null): Record<string, string> {
  const result: Record<string, string> = {};
  if (!header) return result;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (!key) continue;
    try {
      result[key] = decodeURIComponent(value);
    } catch {
      result[key] = value;
    }
  }
  return result;
}

function sign(payload: string): string {
  return crypto
    .createHmac("sha256", SESSION_SECRET)
    .update(payload)
    .digest("hex");
}

// ---------- ログインセッション（署名付きcookie。サーバー側にセッションストアを持たない） ----------

export type SessionPayload = { uid: number; iat: number };

export function createSessionCookieValue(userId: number): string {
  const payload: SessionPayload = { uid: userId, iat: Date.now() };
  const json = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${json}.${sign(json)}`;
}

export function readSessionCookieValue(
  value: string | undefined,
): SessionPayload | null {
  if (!value) return null;
  const [json, signature] = value.split(".");
  if (!json || !signature) return null;
  if (sign(json) !== signature) return null;
  try {
    const payload = JSON.parse(
      Buffer.from(json, "base64url").toString("utf8"),
    ) as SessionPayload;
    if (Date.now() - payload.iat > SESSION_MAX_AGE_MS) return null;
    return payload;
  } catch {
    return null;
  }
}

export function sessionCookieHeader(value: string, secure: boolean): string {
  const maxAgeSeconds = Math.floor(SESSION_MAX_AGE_MS / 1000);
  return `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure ? "; Secure" : ""}`;
}

export function clearSessionCookieHeader(secure: boolean): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? "; Secure" : ""}`;
}

// ---------- 端末の生体認証（Face ID / 指紋）による簡易ログイン用トークン ----------
// 本物のFIDO2署名検証（attestation/assertionの暗号検証）にはライブラリが必要ですが、
// この環境ではパッケージを追加インストールできないため、
// 「端末に保存した高強度ランダムトークン(httpOnlyクッキー) + WebAuthnの生体認証プロンプトでUIをゲートする」
// という実用的な折衷案にしています（README参照）。

export function generateDeviceSecret(): string {
  return crypto.randomBytes(32).toString("hex");
}

export function hashDeviceSecret(secret: string): string {
  return crypto.createHash("sha256").update(secret).digest("hex");
}

export function deviceCookieHeader(value: string, secure: boolean): string {
  const maxAgeSeconds = Math.floor(DEVICE_MAX_AGE_MS / 1000);
  return `${DEVICE_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure ? "; Secure" : ""}`;
}

export function clearDeviceCookieHeader(secure: boolean): string {
  return `${DEVICE_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? "; Secure" : ""}`;
}

export const COOKIE_NAMES = { SESSION: SESSION_COOKIE, DEVICE: DEVICE_COOKIE };

// ---------- メール確認済みトークン（登録・パスワード再設定の次のステップに進む許可証） ----------
// 認証コードの検証に成功した後、これを発行してクライアントに渡します。
// 短時間（15分）だけ有効な署名付きトークンで、サーバー側に状態を持ちません。

export type VerifyTokenPayload = {
  email: string;
  purpose: "register" | "reset";
  iat: number;
};
const VERIFY_TOKEN_MAX_AGE_MS = 15 * 60 * 1000;

export function createVerifyToken(
  email: string,
  purpose: "register" | "reset",
): string {
  const payload: VerifyTokenPayload = {
    email: email.toLowerCase(),
    purpose,
    iat: Date.now(),
  };
  const json = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${json}.${sign(json)}`;
}

export function readVerifyToken(
  token: string | undefined,
): VerifyTokenPayload | null {
  if (!token) return null;
  const [json, signature] = token.split(".");
  if (!json || !signature) return null;
  if (sign(json) !== signature) return null;
  try {
    const payload = JSON.parse(
      Buffer.from(json, "base64url").toString("utf8"),
    ) as VerifyTokenPayload;
    if (Date.now() - payload.iat > VERIFY_TOKEN_MAX_AGE_MS) return null;
    return payload;
  } catch {
    return null;
  }
}
