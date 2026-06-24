import type { Env } from '../types';
import { hmacHex } from './viewer-hash';

export type CodePurpose = 'register' | 'email' | 'reset';

export function generateCode(): string {
  return String(crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000).padStart(6, '0');
}

export function codeHash(env: Env, scope: string, code: string): Promise<string> {
  return hmacHex(env.JWT_SECRET, `evc:${scope}:${code}`);
}

function purposeTitle(purpose: CodePurpose): string {
  if (purpose === 'reset') return '重置密码验证码';
  return purpose === 'email' ? '更换邮箱验证码' : '注册验证码';
}

function renderHtml(code: string, purpose: CodePurpose): string {
  const title = purposeTitle(purpose);
  const spaced = code.split('').join('&nbsp;');
  return `<!doctype html><html lang="zh"><body style="margin:0;background:#f6f5f1;padding:32px 16px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,'PingFang SC','Microsoft YaHei',sans-serif;color:#1c1c1a;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
    <table role="presentation" width="420" cellpadding="0" cellspacing="0" style="max-width:420px;background:#ffffff;border:1px solid #e7e5dd;border-radius:14px;overflow:hidden;">
      <tr><td style="height:4px;line-height:4px;font-size:0;">
        <span style="display:inline-block;width:33.33%;height:4px;background:#2c4f86;">&nbsp;</span><span style="display:inline-block;width:33.33%;height:4px;background:#f4f1e9;">&nbsp;</span><span style="display:inline-block;width:33.32%;height:4px;background:#b23b34;">&nbsp;</span>
      </td></tr>
      <tr><td style="padding:28px 32px 8px;">
        <div style="font-size:13px;letter-spacing:.08em;text-transform:uppercase;color:#8a8780;">${title}</div>
      </td></tr>
      <tr><td style="padding:4px 32px 0;">
        <div style="font-size:15px;line-height:1.7;color:#54514a;">请在验证页面输入以下验证码完成验证。</div>
      </td></tr>
      <tr><td style="padding:20px 32px;">
        <div style="font-size:34px;font-weight:600;letter-spacing:.18em;color:#1c1c1a;text-align:center;background:#f6f5f1;border-radius:10px;padding:16px 0;">${spaced}</div>
      </td></tr>
      <tr><td style="padding:0 32px 28px;">
        <div style="font-size:13px;line-height:1.7;color:#8a8780;">验证码 10 分钟内有效，请勿向他人泄露。如果这不是你本人的操作，忽略此邮件即可。</div>
      </td></tr>
    </table>
  </td></tr></table>
</body></html>`;
}

export async function sendVerificationCode(
  env: Env,
  to: string,
  code: string,
  purpose: CodePurpose
): Promise<boolean> {
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from: env.EMAIL_FROM,
      to: [to],
      subject: `${purposeTitle(purpose)}：${code}`,
      html: renderHtml(code, purpose)
    })
  });
  if (!response.ok) {
    console.error('resend_failed', response.status, await response.text().catch(() => ''));
    return false;
  }
  return true;
}
