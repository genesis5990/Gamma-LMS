// supabase/functions/issue-certificate/index.ts
//
// Issues a completion certificate for the calling user.
//
// Auth: requires a valid Supabase user JWT (Authorization: Bearer ...).
//       The function extracts the user_id from the JWT and uses the
//       service-role key internally to call public.issue_certificate
//       and write the PDF to the private `certificates` bucket.
//
// Body: { full_name: string, course_id?: string, score?: number }
//   - full_name is the recipient's printable name; it is hashed into the cert id.
//
// Response: { cert_hash, pdf_url (signed), issued_at, name, tenant_slug, verify_url }

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { PDFDocument, StandardFonts, rgb } from "npm:pdf-lib@1.17.1";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY     = Deno.env.get("SUPABASE_ANON_KEY")!;
const PUBLIC_SITE  = Deno.env.get("PUBLIC_SITE_URL") ?? "https://mygenesis-training.fly.dev";
const SIGNED_TTL   = 60 * 60 * 24 * 30; // 30 days

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

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST")    return bad(405, "method not allowed");

  // 1. Identify caller from JWT
  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) return bad(401, "missing bearer token");

  const userClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false },
  });
  const { data: userRes, error: userErr } = await userClient.auth.getUser();
  if (userErr || !userRes?.user) return bad(401, "invalid token");
  const userId = userRes.user.id;

  // 2. Parse body
  let body: { full_name?: string; course_id?: string; score?: number };
  try { body = await req.json(); } catch { return bad(400, "invalid json"); }

  const fullName = (body.full_name ?? "").trim();
  const courseId = (body.course_id ?? "crypto101").trim();
  const score    = typeof body.score === "number" ? Math.round(body.score) : null;

  if (!fullName)        return bad(400, "full_name required");
  if (fullName.length > 120) return bad(400, "full_name too long");

  // 3. Service-role client for RPC + storage
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE, {
    auth: { persistSession: false },
  });

  // 4. Issue (or reuse) certificate row + canonical hash
  const { data: cert, error: rpcErr } = await admin.rpc("issue_certificate", {
    p_user_id:   userId,
    p_full_name: fullName,
    p_course_id: courseId,
    p_score:     score,
  });
  if (rpcErr) return bad(500, "rpc failed: " + rpcErr.message);

  const tenantSlug = cert.tenant_slug ?? "";
  const tenantName = cert.tenant_name ?? "Genesis Digital Assets Academy";
  const certHash   = cert.cert_hash as string;
  const issuedAt   = cert.issued_at as string;
  const verifyUrl  = `${PUBLIC_SITE}/verify/${certHash}`;
  const objectPath = `${tenantSlug || "default"}/${certHash}.pdf`;

  // 5. Generate PDF (only if not already stored)
  let pdfUrl = cert.pdf_url as string | null;
  let needsUpload = !pdfUrl;
  if (needsUpload) {
    const pdfBytes = await renderCertificatePdf({
      name: fullName,
      courseTitle: courseTitleFor(courseId),
      issuedAt,
      certHash,
      verifyUrl,
      tenantName,
      score,
    });

    const { error: upErr } = await admin.storage
      .from("certificates")
      .upload(objectPath, pdfBytes, {
        contentType: "application/pdf",
        upsert: true,
      });
    if (upErr) return bad(500, "upload failed: " + upErr.message);

    // pdf_url stores the OBJECT PATH (not the signed URL — that expires)
    await admin.from("certificates").update({ pdf_url: objectPath })
      .eq("cert_hash", certHash);
    pdfUrl = objectPath;
  }

  // 6. Issue a fresh signed URL for download
  const { data: signed, error: sigErr } = await admin.storage
    .from("certificates")
    .createSignedUrl(pdfUrl!, SIGNED_TTL);
  if (sigErr) return bad(500, "sign failed: " + sigErr.message);

  return new Response(JSON.stringify({
    cert_hash:    certHash,
    pdf_url:      signed.signedUrl,
    issued_at:    issuedAt,
    name:         fullName,
    course_id:    courseId,
    tenant_slug:  tenantSlug,
    tenant_name:  tenantName,
    verify_url:   verifyUrl,
  }), { headers: { ...cors, "Content-Type": "application/json" } });
});

// ---------------------------------------------------------------------------
function courseTitleFor(id: string): string {
  if (id === "crypto101") return "Crypto 101 for Investigators";
  return id;
}

async function renderCertificatePdf(opts: {
  name: string;
  courseTitle: string;
  issuedAt: string;
  certHash: string;
  verifyUrl: string;
  tenantName: string;
  score: number | null;
}): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  // Letter landscape
  const page = pdf.addPage([792, 612]);
  const { width, height } = page.getSize();

  const fontTitle = await pdf.embedFont(StandardFonts.HelveticaBold);
  const fontBody  = await pdf.embedFont(StandardFonts.Helvetica);
  const fontMono  = await pdf.embedFont(StandardFonts.Courier);

  const ink   = rgb(0.024, 0.039, 0.086);   // #060A16
  const muted = rgb(0.36, 0.40, 0.53);      // #5b6788
  const gold  = rgb(0.78, 0.65, 0.29);      // #c8a64a

  // Outer border
  page.drawRectangle({
    x: 28, y: 28, width: width - 56, height: height - 56,
    borderColor: ink, borderWidth: 2,
  });
  // Inner border (gold)
  page.drawRectangle({
    x: 38, y: 38, width: width - 76, height: height - 76,
    borderColor: gold, borderWidth: 1,
  });

  // Header
  centerText(page, opts.tenantName.toUpperCase(), height - 90, fontBody, 13, muted, 4);
  centerText(page, "CERTIFICATE OF COMPLETION",  height - 130, fontTitle, 28, ink);

  // Recipient
  centerText(page, "This certifies that",          height - 200, fontBody,  14, muted);
  centerText(page, opts.name,                       height - 240, fontTitle, 30, ink);

  // Course
  centerText(page, "has successfully completed",    height - 290, fontBody,  14, muted);
  centerText(page, opts.courseTitle,                height - 325, fontTitle, 22, ink);

  // Score (optional)
  if (opts.score !== null) {
    centerText(page, `Final score: ${opts.score}%`, height - 360, fontBody, 12, muted);
  }

  // Date
  const dateStr = new Date(opts.issuedAt).toLocaleDateString("en-US", {
    year: "numeric", month: "long", day: "numeric",
  });
  centerText(page, `Issued ${dateStr}`,             height - 400, fontBody, 12, muted);

  // Hash + verify
  const hashLabel = "Certificate ID";
  page.drawText(hashLabel, { x: 60, y: 110, size: 9, font: fontBody, color: muted });
  page.drawText(opts.certHash, { x: 60, y: 92, size: 9, font: fontMono, color: ink });

  page.drawText("Verify at",  { x: 60, y: 70, size: 9, font: fontBody, color: muted });
  page.drawText(opts.verifyUrl, { x: 60, y: 52, size: 10, font: fontMono, color: ink });

  return await pdf.save();
}

function centerText(page: any, text: string, y: number, font: any, size: number,
                    color: any, characterSpacing = 0) {
  const w = font.widthOfTextAtSize(text, size) + characterSpacing * (text.length - 1);
  page.drawText(text, {
    x: (page.getWidth() - w) / 2,
    y, size, font, color, characterSpacing,
  });
}
