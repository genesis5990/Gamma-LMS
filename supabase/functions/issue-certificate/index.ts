// supabase/functions/issue-certificate/index.ts  — v0.4.89
//
// Issues a completion certificate for the calling user.
//
// Auth: requires a valid Supabase user JWT (Authorization: Bearer ...).
//       The function extracts the user_id from the JWT and uses the
//       service-role key internally to call public.issue_certificate
//       and write the PDF to the private `certificates` bucket.
//
// Body: { course_id?: string, score?: number, regen?: boolean }
//   - full_name is IGNORED if supplied; the name comes from profiles.full_name.
//   - regen=true (or ?regen=1) re-renders even if pdf_url already exists.
//
// v0.4.87 visual upgrade: parchment background, double border + gold corner
// brackets, Cormorant Garamond serif (fetched from Google Fonts at cold start
// with fontkit registration), gold seal, QR code for the verify URL.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { PDFDocument, StandardFonts, rgb, degrees } from "npm:pdf-lib@1.17.1";
import fontkit from "npm:@pdf-lib/fontkit@1.1.1";
import qrcode from "npm:qrcode-generator@1.4.4";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY     = Deno.env.get("SUPABASE_ANON_KEY")!;
const PUBLIC_SITE  = Deno.env.get("PUBLIC_SITE_URL") ?? "https://deconflict.com";
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
  let body: { course_id?: string; score?: number; regen?: boolean };
  try { body = await req.json(); } catch { return bad(400, "invalid json"); }

  const url = new URL(req.url);
  const regen = body.regen === true || url.searchParams.get("regen") === "1";

  const courseId = (body.course_id ?? "crypto101").trim();
  const score    = typeof body.score === "number" ? Math.round(body.score) : null;

  // 3. Service-role client
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE, {
    auth: { persistSession: false },
  });

  // 3a. Read recipient name from profile
  const { data: profile, error: profErr } = await admin
    .from("profiles")
    .select("full_name")
    .eq("id", userId)
    .maybeSingle();
  if (profErr) return bad(500, "profile lookup failed: " + profErr.message);
  const fullName = (profile?.full_name ?? "").trim();
  if (!fullName)             return bad(400, "profile missing full_name; set it before requesting a certificate");
  if (fullName.length > 120) return bad(400, "profile full_name too long");

  // 3b. Require completed enrollment
  const { data: enrollment, error: enrErr } = await admin
    .from("enrollments")
    .select("status")
    .eq("user_id", userId)
    .eq("course_id", courseId)
    .maybeSingle();
  if (enrErr)                            return bad(500, "enrollment lookup failed: " + enrErr.message);
  if (!enrollment)                        return bad(403, "not enrolled in this course");
  if (enrollment.status !== "completed")  return bad(403, "course not yet completed");

  // 3c. Require at least one passed quiz_attempts row
  const { count: passedCount, error: attErr } = await admin
    .from("quiz_attempts")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .eq("passed", true);
  if (attErr)                  return bad(500, "attempt lookup failed: " + attErr.message);
  if (!passedCount || passedCount < 1) return bad(403, "no passing quiz attempt on file");

  // 4. Issue (or reuse) certificate row + canonical hash
  const { data: cert, error: rpcErr } = await admin.rpc("issue_certificate", {
    p_user_id:   userId,
    p_full_name: fullName,
    p_course_id: courseId,
    p_score:     score,
  });
  if (rpcErr) return bad(500, "rpc failed: " + rpcErr.message);

  const tenantSlug = cert.tenant_slug ?? "";
  const tenantName = (cert.tenant_name ?? "").trim() || "Deconflict";
  const certHash   = cert.cert_hash as string;
  const issuedAt   = cert.issued_at as string;
  const verifyUrl  = `${PUBLIC_SITE}/verify/${certHash}`;
  const objectPath = `${tenantSlug || "default"}/${certHash}.pdf`;

  // 5. Generate PDF — render if missing OR if regen requested
  let pdfUrl = cert.pdf_url as string | null;
  const needsUpload = !pdfUrl || regen;
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

    await admin.from("certificates").update({ pdf_url: objectPath })
      .eq("cert_hash", certHash);
    pdfUrl = objectPath;
  }

  // 6. Signed URL
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
  if (id === "crypto101")              return "Crypto 101 for Investigators";
  if (id === "crypto-investigations")  return "Cryptocurrency & Digital Assets Investigations";
  return id;
}

// ---------------------------------------------------------------------------
// Font caching — fetched once per cold start. Cormorant Garamond TTFs from
// Google Fonts. Falls back to Helvetica-Bold if fetch fails so we never 500.
//
// We pull from fontsource on jsDelivr rather than gstatic.com directly: the
// gstatic TTFs ship as variable-font slices that confuse pdf-lib/fontkit and
// produce broken glyph mapping (most letters render as spaces). Fontsource
// publishes plain static TTFs which embed cleanly.
const CG_URLS = {
  regular600: "https://cdn.jsdelivr.net/fontsource/fonts/cormorant-garamond@latest/latin-600-normal.ttf",
  regular700: "https://cdn.jsdelivr.net/fontsource/fonts/cormorant-garamond@latest/latin-700-normal.ttf",
  italic400:  "https://cdn.jsdelivr.net/fontsource/fonts/cormorant-garamond@latest/latin-400-italic.ttf",
};

let fontBytesCache: { sb?: Uint8Array; bold?: Uint8Array; italic?: Uint8Array } | null = null;

// Deconflict brand artwork — baked at build-time, read once at cold start.
let logoBytesCache: { mark?: Uint8Array; wordmark?: Uint8Array } | null = null;
async function loadLogoBytes() {
  if (logoBytesCache) return logoBytesCache;
  const read = async (name: string): Promise<Uint8Array | undefined> => {
    try {
      return await Deno.readFile(new URL(`./assets/${name}`, import.meta.url));
    } catch { return undefined; }
  };
  const [mark, wordmark] = await Promise.all([
    read("deconflict-mark.png"),
    read("deconflict-wordmark.png"),
  ]);
  logoBytesCache = { mark, wordmark };
  return logoBytesCache;
}

async function loadFontBytes() {
  if (fontBytesCache) return fontBytesCache;
  const fetchTtf = async (u: string): Promise<Uint8Array | undefined> => {
    try {
      const r = await fetch(u);
      if (!r.ok) return undefined;
      return new Uint8Array(await r.arrayBuffer());
    } catch { return undefined; }
  };
  const [sb, bold, italic] = await Promise.all([
    fetchTtf(CG_URLS.regular600),
    fetchTtf(CG_URLS.regular700),
    fetchTtf(CG_URLS.italic400),
  ]);
  fontBytesCache = { sb, bold, italic };
  return fontBytesCache;
}

// ---------------------------------------------------------------------------
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
  pdf.registerFontkit(fontkit);

  // Letter landscape (792 × 612)
  const page = pdf.addPage([792, 612]);
  const W = page.getWidth();
  const H = page.getHeight();

  // Try to embed Cormorant Garamond; fall back to Helvetica if any TTF missing.
  let fontSerif: any, fontSerifBold: any, fontItalic: any;
  const helvBold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const helv     = await pdf.embedFont(StandardFonts.Helvetica);
  const helvObl  = await pdf.embedFont(StandardFonts.HelveticaOblique);
  try {
    const fb = await loadFontBytes();
    fontSerif     = fb.sb     ? await pdf.embedFont(fb.sb,     { subset: true }) : helvBold;
    fontSerifBold = fb.bold   ? await pdf.embedFont(fb.bold,   { subset: true }) : helvBold;
    fontItalic    = fb.italic ? await pdf.embedFont(fb.italic, { subset: true }) : helvObl;
  } catch {
    fontSerif = helvBold; fontSerifBold = helvBold; fontItalic = helvObl;
  }
  const fontSans = helv;
  const fontSansBold = helvBold;
  const fontMono = await pdf.embedFont(StandardFonts.Courier);

  // Colors (matching certificate_preview.html)
  const ink    = rgb(0.024, 0.039, 0.086);   // #060A16
  const ink2   = rgb(0.055, 0.078, 0.160);   // #0E1429
  const muted  = rgb(0.357, 0.404, 0.533);   // #5b6788
  const paper  = rgb(0.984, 0.980, 0.965);   // #fbfaf6 (cream)
  const gold   = rgb(0.784, 0.651, 0.290);   // #c8a64a
  const goldDk = rgb(0.722, 0.565, 0.173);   // #b8902c
  const goldLt = rgb(0.910, 0.784, 0.471);   // #e8c879
  const goldFaint = rgb(0.949, 0.859, 0.627); // #f1dca0
  const goldDisc  = rgb(0.996, 0.976, 0.902); // #fef9e6

  // 1. Parchment background
  page.drawRectangle({ x: 0, y: 0, width: W, height: H, color: paper });

  // 2. Double border
  page.drawRectangle({
    x: 28, y: 28, width: W - 56, height: H - 56,
    borderColor: ink, borderWidth: 2,
  });
  page.drawRectangle({
    x: 38, y: 38, width: W - 76, height: H - 76,
    borderColor: gold, borderWidth: 1,
  });

  // 3. Corner L-brackets (90×90, 56pt from outer edge)
  const cb = 56, cbSz = 90, cbW = 0.8;
  // top-left
  page.drawLine({ start: { x: cb, y: H - cb }, end: { x: cb + cbSz, y: H - cb }, color: gold, thickness: cbW, opacity: 0.6 });
  page.drawLine({ start: { x: cb, y: H - cb }, end: { x: cb, y: H - cb - cbSz }, color: gold, thickness: cbW, opacity: 0.6 });
  // top-right
  page.drawLine({ start: { x: W - cb, y: H - cb }, end: { x: W - cb - cbSz, y: H - cb }, color: gold, thickness: cbW, opacity: 0.6 });
  page.drawLine({ start: { x: W - cb, y: H - cb }, end: { x: W - cb, y: H - cb - cbSz }, color: gold, thickness: cbW, opacity: 0.6 });
  // bottom-left
  page.drawLine({ start: { x: cb, y: cb }, end: { x: cb + cbSz, y: cb }, color: gold, thickness: cbW, opacity: 0.6 });
  page.drawLine({ start: { x: cb, y: cb }, end: { x: cb, y: cb + cbSz }, color: gold, thickness: cbW, opacity: 0.6 });
  // bottom-right
  page.drawLine({ start: { x: W - cb, y: cb }, end: { x: W - cb - cbSz, y: cb }, color: gold, thickness: cbW, opacity: 0.6 });
  page.drawLine({ start: { x: W - cb, y: cb }, end: { x: W - cb, y: cb + cbSz }, color: gold, thickness: cbW, opacity: 0.6 });

  // 4. Header — Deconflict wordmark (logo + DECONFLICT lockup), centered
  const logos = await loadLogoBytes();
  let wordmarkImg: any = null;
  let markImg: any = null;
  try { wordmarkImg = logos.wordmark ? await pdf.embedPng(logos.wordmark) : null; } catch { /* noop */ }
  try { markImg     = logos.mark     ? await pdf.embedPng(logos.mark)     : null; } catch { /* noop */ }

  if (wordmarkImg) {
    // Target ~28pt tall, centered around y = H - 78
    const targetH = 30;
    const scale = targetH / wordmarkImg.height;
    const drawW = wordmarkImg.width * scale;
    const drawH = targetH;
    page.drawImage(wordmarkImg, {
      x: (W - drawW) / 2,
      y: H - 90,
      width: drawW,
      height: drawH,
    });
  } else {
    // Fallback: textual wordmark
    centerText(page, "DECONFLICT", H - 78, fontSansBold, 14, ink, 6);
  }

  // Tenant line (small caps muted, letter-spaced)
  centerText(page, "CRYPTOCURRENCY INVESTIGATION PROGRAM",
    H - 110, fontSans, 8, muted, 4);

  // Gold rule with center diamond
  const ruleY = H - 130;
  const ruleHalf = 100;
  const ruleCx = W / 2;
  page.drawLine({
    start: { x: ruleCx - ruleHalf, y: ruleY }, end: { x: ruleCx - 8, y: ruleY },
    color: gold, thickness: 0.6,
  });
  page.drawLine({
    start: { x: ruleCx + 8, y: ruleY }, end: { x: ruleCx + ruleHalf, y: ruleY },
    color: gold, thickness: 0.6,
  });
  // diamond at center (rotated square)
  page.drawRectangle({
    x: ruleCx - 3, y: ruleY - 3, width: 6, height: 6,
    color: gold, rotate: degrees(45),
  });

  // 5. Title
  centerText(page, "CERTIFICATE OF COMPLETION", H - 175, fontSerif, 38, ink, 2);

  // Subtitle (italic)
  centerText(page, "Awarded for the successful completion of accredited coursework",
    H - 200, fontItalic, 14, muted, 0.5);

  // "This certifies that"
  centerText(page, "THIS CERTIFIES THAT", H - 245, fontSans, 10, muted, 3);

  // Recipient name (large serif)
  const nameSize = 40;
  centerText(page, opts.name, H - 290, fontSerif, nameSize, ink, 1.5);

  // Faint gold underline beneath the name
  const nameW = textWidth(opts.name, fontSerif, nameSize, 1.5);
  page.drawLine({
    start: { x: W / 2 - nameW / 2 - 24, y: H - 302 },
    end:   { x: W / 2 + nameW / 2 + 24, y: H - 302 },
    color: gold, thickness: 0.7, opacity: 0.55,
  });

  // "has successfully completed the course"
  centerText(page, "HAS SUCCESSFULLY COMPLETED THE COURSE", H - 330, fontSans, 10, muted, 2);

  // Course title
  centerText(page, opts.courseTitle, H - 360, fontSerif, 22, ink2, 0.5);

  // 6. Meta row — 3 columns
  const dateStr = new Date(opts.issuedAt).toLocaleDateString("en-US", {
    year: "numeric", month: "long", day: "numeric",
  });
  const scoreStr = opts.score !== null ? `${opts.score}%` : "—";
  const meta = [
    { label: "Issued:",      value: dateStr },
    { label: "Final score:", value: scoreStr },
    { label: "Program:",     value: opts.tenantName },
  ];
  const metaY = H - 405;
  // Render each pair separately, centered as a group of three with gaps
  drawMetaRow(page, meta, metaY, fontSans, fontSansBold, muted, ink);

  // 7. Footer — 3 columns at bottom: signature (left) | seal (center) | verify (right)
  const footTop = 150;

  // LEFT: signature
  const sigCx = 160;
  const sigCy = 90;
  centerTextAtCenter(page, "Genesis Faculty", sigCx, sigCy + 22, fontItalic, 22, ink, 0);
  // signature line
  page.drawLine({
    start: { x: sigCx - 90, y: sigCy + 12 },
    end:   { x: sigCx + 90, y: sigCy + 12 },
    color: ink, thickness: 0.7,
  });
  centerTextAtCenter(page, "PROGRAM DIRECTOR · DECONFLICT", sigCx, sigCy - 4,
    fontSans, 7, muted, 2);

  // CENTER: gold seal — 110pt diameter
  const sealCx = W / 2;
  const sealCy = 100;
  const sealOuter = 55; // radius
  // Outer ring (darker gold)
  page.drawCircle({ x: sealCx, y: sealCy, size: sealOuter, color: goldDk });
  // Lighter gold ring
  page.drawCircle({ x: sealCx, y: sealCy, size: sealOuter - 3, color: goldLt });
  // Cream/gold inner disc
  page.drawCircle({ x: sealCx, y: sealCy, size: sealOuter - 6, color: goldFaint });
  page.drawCircle({ x: sealCx, y: sealCy, size: sealOuter - 9, color: goldDisc });
  // Border ring (thin gold)
  page.drawCircle({
    x: sealCx, y: sealCy, size: sealOuter - 6,
    borderColor: goldDk, borderWidth: 0.6,
  });

  // Seal text (top + bottom) with embedded Deconflict mark in the middle
  centerTextAtCenter(page, "CERTIFIED", sealCx, sealCy + 22, fontSerifBold, 9, ink, 1.2);
  if (markImg) {
    const sealMarkH = 36;
    const sealMarkScale = sealMarkH / markImg.height;
    const sealMarkW = markImg.width * sealMarkScale;
    page.drawImage(markImg, {
      x: sealCx - sealMarkW / 2,
      y: sealCy - sealMarkH / 2 - 4,
      width: sealMarkW,
      height: sealMarkH,
    });
  } else {
    // Fallback: small "D" if the asset is missing
    centerTextAtCenter(page, "D", sealCx, sealCy - 8, fontItalic, 32, ink2, 0);
  }
  centerTextAtCenter(page, "MMXXVI", sealCx, sealCy - 32, fontSansBold, 7, ink2, 3);

  // RIGHT: QR code + verify text
  const qrSize = 70;
  const qrRightMargin = 75;
  const qrX = W - qrRightMargin - qrSize;
  const qrY = 105;
  await drawQrCode(page, opts.verifyUrl, qrX, qrY, qrSize, ink);

  // Verify label + URL + hash
  const verifyCx = qrX + qrSize / 2;
  centerTextAtCenter(page, "VERIFY AT", verifyCx, qrY - 12, fontSans, 7, muted, 2);
  // short URL (host + first 12 of hash)
  const shortHash = opts.certHash.slice(0, 12);
  centerTextAtCenter(page,
    "deconflict.com/verify/" + shortHash,
    verifyCx, qrY - 24, fontMono, 6.5, ink, 0);
  // full hash split in two lines
  const half = Math.ceil(opts.certHash.length / 2);
  const hashRow1 = opts.certHash.slice(0, half);
  const hashRow2 = opts.certHash.slice(half);
  centerTextAtCenter(page, hashRow1, verifyCx, qrY - 36, fontMono, 5.5, ink2, 0);
  centerTextAtCenter(page, hashRow2, verifyCx, qrY - 44, fontMono, 5.5, ink2, 0);

  return await pdf.save();
}

// ---------------------------------------------------------------------------
// QR code rendering — uses qrcode-generator to produce a bit matrix, then
// draws each "dark" module as a small filled rectangle in pdf-lib. No PNG
// embedding required, keeps the function dependency-light.
async function drawQrCode(page: any, text: string, x: number, y: number, size: number, color: any) {
  // typeNumber 0 = auto-fit, errorCorrectLevel "M"
  const qr = (qrcode as any)(0, "M");
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  const cell = size / n;
  // Quiet zone implicit: we draw modules only inside [x, x+size].
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (qr.isDark(r, c)) {
        page.drawRectangle({
          x: x + c * cell,
          y: y + size - (r + 1) * cell,
          width: cell,
          height: cell,
          color,
        });
      }
    }
  }
}

// ---------------------------------------------------------------------------
function textWidth(text: string, font: any, size: number, characterSpacing = 0): number {
  return font.widthOfTextAtSize(text, size) + characterSpacing * Math.max(0, text.length - 1);
}

function centerText(page: any, text: string, y: number, font: any, size: number,
                    color: any, characterSpacing = 0) {
  const w = textWidth(text, font, size, characterSpacing);
  page.drawText(text, {
    x: (page.getWidth() - w) / 2,
    y, size, font, color, characterSpacing,
  });
}

function centerTextAt(page: any, text: string, x: number, y: number, font: any, size: number,
                      color: any, characterSpacing = 0, align: "left" | "center" = "center") {
  if (align === "left") {
    page.drawText(text, { x, y, size, font, color, characterSpacing });
    return;
  }
  const w = textWidth(text, font, size, characterSpacing);
  page.drawText(text, { x: x - w / 2, y, size, font, color, characterSpacing });
}

function centerTextAtCenter(page: any, text: string, cx: number, y: number, font: any, size: number,
                            color: any, characterSpacing = 0) {
  const w = textWidth(text, font, size, characterSpacing);
  page.drawText(text, { x: cx - w / 2, y, size, font, color, characterSpacing });
}

function drawMetaRow(page: any, items: { label: string; value: string }[], y: number,
                     fontLabel: any, fontValue: any, mutedColor: any, inkColor: any) {
  const size = 9;
  const gap = 8;
  const colGap = 36;

  // Measure each item: "Label: Value"
  const widths = items.map((it) => {
    const lw = fontLabel.widthOfTextAtSize(it.label, size);
    const vw = fontValue.widthOfTextAtSize(it.value, size);
    return lw + gap + vw;
  });
  const total = widths.reduce((a, b) => a + b, 0) + colGap * (items.length - 1);
  let x = (page.getWidth() - total) / 2;
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    page.drawText(it.label, { x, y, size, font: fontLabel, color: mutedColor });
    const lw = fontLabel.widthOfTextAtSize(it.label, size);
    page.drawText(it.value, { x: x + lw + gap, y, size, font: fontValue, color: inkColor });
    x += widths[i] + colGap;
  }
}
