// supabase/functions/approve-request/index.ts
//
// Approves or denies a pending access_request and emails the result.
//
// Auth:  requires a Supabase user JWT (verify_jwt = true). The function
//        calls public.approve_access_request / public.deny_access_request
//        as that user, so RLS + RPC checks gate authorization.
//
// Body:  { request_id: uuid, action: 'approve' | 'deny', reason?: string }
//
// On approve:
//   1. RPC public.approve_access_request(p_request_id) → returns invitation info
//   2. POST /auth/v1/admin/generate_link (service role) → magic link
//   3. POST https://api.resend.com/emails  → branded email with magic link
//
// On deny:
//   1. RPC public.deny_access_request(p_request_id, p_reason)
//   2. Resend a polite denial email

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL  = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY      = Deno.env.get("SUPABASE_ANON_KEY")!;
const RESEND_KEY    = Deno.env.get("RESEND_API_KEY")!;
const PUBLIC_SITE   = Deno.env.get("PUBLIC_SITE_URL") ?? "https://mygenesis-training.fly.dev";
const FROM_ADDRESS  = Deno.env.get("RESEND_FROM") ?? "Genesis Digital Assets Academy <noreply@mygenesis-training.com>";

const cors = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function bad(status: number, msg: string) {
  return new Response(JSON.stringify({ error: msg }), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

function ok(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

function escapeHtml(s: string) {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

async function generateMagicLink(email: string, redirectTo: string): Promise<string | null> {
  const resp = await fetch(`${SUPABASE_URL}/auth/v1/admin/generate_link`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: SERVICE_ROLE,
      Authorization: `Bearer ${SERVICE_ROLE}`,
    },
    body: JSON.stringify({
      type: "magiclink",
      email,
      options: { redirect_to: redirectTo },
    }),
  });
  if (!resp.ok) {
    const txt = await resp.text();
    console.error("[approve-request] generate_link failed", resp.status, txt);
    return null;
  }
  const data = await resp.json();
  return data?.action_link || data?.properties?.action_link || null;
}

async function sendEmail(to: string, subject: string, html: string) {
  const resp = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${RESEND_KEY}`,
    },
    body: JSON.stringify({ from: FROM_ADDRESS, to, subject, html }),
  });
  if (!resp.ok) {
    const txt = await resp.text();
    console.error("[approve-request] resend failed", resp.status, txt);
    return false;
  }
  return true;
}

function approveEmailHtml(args: {
  full_name: string;
  tenant_name: string;
  tenant_slug: string;
  magic_link: string;
  logo_url?: string | null;
}) {
  const name  = escapeHtml(args.full_name);
  const tname = escapeHtml(args.tenant_name);
  const link  = args.magic_link; // already a URL — don't double-escape
  const logo  = args.logo_url
    ? `<img src="${escapeHtml(args.logo_url)}" alt="${tname}" style="max-height:48px;margin-bottom:16px" />`
    : "";

  return `<!doctype html><html><body style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#0d1424;background:#f7f8fc;margin:0;padding:24px;">
    <div style="max-width:560px;margin:0 auto;background:#fff;border-radius:12px;border:1px solid #d9dfee;padding:32px;">
      ${logo}
      <h2 style="margin:0 0 12px;font-size:20px;">Welcome, ${name}.</h2>
      <p style="margin:0 0 16px;color:#3a4666;">Your access request to <strong>${tname}</strong> training has been approved.</p>
      <p style="margin:0 0 24px;color:#3a4666;">Click the button below to sign in. The link will sign you in automatically and bring you to your training portal.</p>
      <p style="margin:0 0 24px;text-align:center;">
        <a href="${link}" style="display:inline-block;background:#1f63d6;color:#fff;text-decoration:none;font-weight:600;padding:12px 24px;border-radius:8px;">Sign in to ${tname}</a>
      </p>
      <p style="margin:0 0 12px;color:#5b6788;font-size:13px;">This invitation expires in 30 days. If the button doesn't work, copy and paste this URL into your browser:</p>
      <p style="margin:0;word-break:break-all;color:#5b6788;font-size:12px;">${escapeHtml(link)}</p>
      <hr style="border:0;border-top:1px solid #d9dfee;margin:24px 0;" />
      <p style="margin:0;color:#5b6788;font-size:12px;">Genesis Digital Assets Academy &middot; Investigator training in cryptocurrency &amp; blockchain forensics.</p>
    </div>
  </body></html>`;
}

function denyEmailHtml(args: {
  full_name: string;
  tenant_name: string;
  reason?: string | null;
}) {
  const name  = escapeHtml(args.full_name);
  const tname = escapeHtml(args.tenant_name);
  const reasonBlock = args.reason
    ? `<p style="margin:0 0 16px;color:#3a4666;"><strong>Reason from reviewer:</strong> ${escapeHtml(args.reason)}</p>`
    : "";

  return `<!doctype html><html><body style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#0d1424;background:#f7f8fc;margin:0;padding:24px;">
    <div style="max-width:560px;margin:0 auto;background:#fff;border-radius:12px;border:1px solid #d9dfee;padding:32px;">
      <h2 style="margin:0 0 12px;font-size:20px;">Access request — ${tname}</h2>
      <p style="margin:0 0 16px;color:#3a4666;">Hello ${name},</p>
      <p style="margin:0 0 16px;color:#3a4666;">Thank you for your interest in the <strong>${tname}</strong> training program. After review, your access request was not approved at this time.</p>
      ${reasonBlock}
      <p style="margin:0 0 16px;color:#3a4666;">If you believe this was made in error or you have additional context to share, please contact your program administrator directly.</p>
      <hr style="border:0;border-top:1px solid #d9dfee;margin:24px 0;" />
      <p style="margin:0;color:#5b6788;font-size:12px;">Genesis Digital Assets Academy</p>
    </div>
  </body></html>`;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST")    return bad(405, "method not allowed");

  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) return bad(401, "missing bearer token");

  let body: { request_id?: string; action?: string; reason?: string };
  try {
    body = await req.json();
  } catch {
    return bad(400, "invalid json body");
  }
  const { request_id, action, reason } = body || {};
  if (!request_id || typeof request_id !== "string") return bad(400, "request_id required");
  if (action !== "approve" && action !== "deny")     return bad(400, "action must be 'approve' or 'deny'");

  // Caller-scoped client: RPC runs as the admin user; RLS + RPC auth checks gate it.
  const userClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false },
  });

  // Service-role client for tenant lookups + magic link generation.
  const adminClient = createClient(SUPABASE_URL, SERVICE_ROLE, {
    auth: { persistSession: false },
  });

  if (action === "approve") {
    const { data: rpcData, error: rpcErr } = await userClient.rpc("approve_access_request", {
      p_request_id: request_id,
    });
    if (rpcErr) {
      console.error("[approve-request] approve RPC failed", rpcErr);
      return bad(403, rpcErr.message || "approve failed");
    }
    const info = rpcData as {
      invitation_id: string;
      email: string;
      full_name: string;
      tenant_id: string;
      tenant_name: string;
      tenant_slug: string;
    };

    const redirectTo = `${PUBLIC_SITE}/${info.tenant_slug}`;
    const magicLink  = await generateMagicLink(info.email, redirectTo);
    if (!magicLink) return bad(500, "failed to generate magic link");

    // Tenant logo for branded email
    const { data: tenant } = await adminClient
      .from("tenants")
      .select("logo_url, logo_url_white")
      .eq("id", info.tenant_id)
      .single();
    const logo = tenant?.logo_url
      ? (tenant.logo_url.startsWith("http") ? tenant.logo_url : `${PUBLIC_SITE}${tenant.logo_url}`)
      : null;

    const subject = `[${info.tenant_name}] Your training access has been approved`;
    const html    = approveEmailHtml({
      full_name:   info.full_name,
      tenant_name: info.tenant_name,
      tenant_slug: info.tenant_slug,
      magic_link:  magicLink,
      logo_url:    logo,
    });
    const sent = await sendEmail(info.email, subject, html);
    if (!sent) return bad(500, "approved, but failed to send invitation email");

    return ok({ ok: true, action: "approved", email: info.email });
  }

  // Deny path
  const { data: rpcData, error: rpcErr } = await userClient.rpc("deny_access_request", {
    p_request_id: request_id,
    p_reason:     reason ?? null,
  });
  if (rpcErr) {
    console.error("[approve-request] deny RPC failed", rpcErr);
    return bad(403, rpcErr.message || "deny failed");
  }
  const info = rpcData as {
    email: string;
    full_name: string;
    tenant_name: string;
    deny_reason: string | null;
  };

  const subject = `[${info.tenant_name}] Update on your access request`;
  const html    = denyEmailHtml({
    full_name:   info.full_name,
    tenant_name: info.tenant_name,
    reason:      info.deny_reason,
  });
  const sent = await sendEmail(info.email, subject, html);
  // Not fatal if email fails — request is already denied
  if (!sent) console.warn("[approve-request] denial email send failed");

  return ok({ ok: true, action: "denied", email: info.email, email_sent: sent });
});
