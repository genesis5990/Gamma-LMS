#!/usr/bin/env node
/**
 * Import an existing .course.json file into the authoring-studio Supabase tables.
 *
 * Idempotent on slug — re-running deletes the previous version_number=1 row
 * (cascading to all its modules/lessons/pages/quizzes) and re-imports.
 *
 * Usage (run inside the Fly machine where SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY
 * are present as env vars):
 *
 *   node scripts/import_course_json.mjs <path-to-course-json> [slug]
 *
 * Or with explicit env:
 *   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
 *     node scripts/import_course_json.mjs ./public/preview/le-field-tactics.course.json
 */
import fs from 'node:fs/promises';
import path from 'node:path';

const SUPABASE_URL = process.env.SUPABASE_URL?.replace(/\/$/, '');
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY env vars');
  process.exit(1);
}

async function rest(method, p, { body, params, prefer } = {}) {
  const url = new URL(`${SUPABASE_URL}/rest/v1${p}`);
  if (params) Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  const res = await fetch(url, {
    method,
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: prefer || 'return=representation',
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`HTTP ${res.status} ${method} ${p}: ${t}`);
  }
  const txt = await res.text();
  return txt ? JSON.parse(txt) : null;
}

function normalizePassThreshold(v) {
  if (v === undefined || v === null || v === '') return 80;
  const n = typeof v === 'string' ? parseFloat(v) : Number(v);
  if (!Number.isFinite(n) || n <= 0) return 80;
  // 0 < x <= 1  => fraction, scale to percent
  // 1 < x <= 100 => already percent
  return n <= 1 ? Math.round(n * 100) : Math.round(n);
}

async function upsertCourse(slug, course) {
  const payload = {
    slug,
    title: course.title,
    description: course.description ?? null,
    audience: course.audience ?? null,
    prerequisites: course.prerequisites ?? null,
    pass_threshold: normalizePassThreshold(course.pass_threshold),
    includes_disclaimer: !!course.includes_disclaimer,
    visibility: 'preview',
  };
  const rows = await rest('POST', '/courses', {
    params: { on_conflict: 'slug' },
    body: payload,
    prefer: 'return=representation,resolution=merge-duplicates',
  });
  if (Array.isArray(rows) && rows.length) return rows[0];
  const got = await rest('GET', '/courses',
    { params: { slug: `eq.${slug}`, select: '*' } });
  return got[0];
}

async function deleteVersion(courseId, versionNumber) {
  await rest('DELETE', '/course_versions', {
    params: { course_id: `eq.${courseId}`, version_number: `eq.${versionNumber}` },
  });
}

async function insertVersion(courseId) {
  const rows = await rest('POST', '/course_versions', {
    body: {
      course_id: courseId,
      version_number: 1,
      status: 'published',
      notes: 'Imported from .course.json (initial seed)',
    },
  });
  return rows[0];
}

async function insertModules(versionId, modules) {
  const out = [];
  for (let i = 0; i < modules.length; i++) {
    const m = modules[i];
    const slug = m.id || `m${i}`;
    const hasKc = !!(m.knowledge_check && m.knowledge_check.questions?.length);
    const ins = await rest('POST', '/modules', {
      body: {
        course_version_id: versionId,
        slug,
        title: m.title || '',
        description: m.description ?? null,
        position: i,
        has_knowledge_check: hasKc,
      },
    });
    out.push({ id: ins[0].id, source: m, slug });
  }
  return out;
}

async function insertLessonsAndPages(moduleId, lessons) {
  for (let li = 0; li < lessons.length; li++) {
    const l = lessons[li];
    const ins = await rest('POST', '/lessons', {
      body: {
        module_id: moduleId,
        slug: l.id || `lesson-${li}`,
        title: l.title || '',
        position: li,
      },
    });
    const lessonId = ins[0].id;
    const pages = l.pages || [];
    for (let pi = 0; pi < pages.length; pi++) {
      const p = pages[pi];
      await rest('POST', '/pages', {
        body: {
          lesson_id: lessonId,
          position: pi,
          page_type: p.type || 'text',
          title: p.title ?? null,
          body_html: p.content || '',
        },
      });
    }
  }
}

async function insertModuleQuiz(moduleId, kc) {
  if (!kc?.questions?.length) return 0;
  for (let qi = 0; qi < kc.questions.length; qi++) {
    const q = kc.questions[qi];
    await rest('POST', '/module_quiz_questions', {
      body: {
        module_id: moduleId,
        position: qi,
        question: q.q || '',
        options: q.options || [],
        answer_index: parseInt(q.answer ?? 0, 10),
        reference: q.ref ?? null,
      },
    });
  }
  return kc.questions.length;
}

async function insertFinalExam(versionId, finalExam, moduleSlugs) {
  if (!finalExam?.questions?.length) return 0;
  for (let qi = 0; qi < finalExam.questions.length; qi++) {
    const q = finalExam.questions[qi];
    let srcSlug = null;
    const ref = q.ref || '';
    if (ref) {
      for (const slug of moduleSlugs) {
        if (ref.includes(slug)) { srcSlug = slug; break; }
      }
    }
    await rest('POST', '/final_exam_questions', {
      body: {
        course_version_id: versionId,
        position: qi,
        question: q.q || '',
        options: q.options || [],
        answer_index: parseInt(q.answer ?? 0, 10),
        reference: ref,
        source_module_slug: srcSlug,
      },
    });
  }
  return finalExam.questions.length;
}

async function setCurrentVersion(courseId, versionId) {
  await rest('PATCH', '/courses', {
    params: { id: `eq.${courseId}` },
    body: { current_version_id: versionId },
  });
}

async function main() {
  const filePath = process.argv[2];
  const slugOverride = process.argv[3];
  if (!filePath) {
    console.error('Usage: node import_course_json.mjs <path> [slug]');
    process.exit(2);
  }
  const raw = await fs.readFile(filePath, 'utf-8');
  const course = JSON.parse(raw);

  const slug = slugOverride
    || course.id
    || path.basename(filePath).replace(/\.course\.json$/, '').replace(/\.json$/, '');

  console.log(`Importing slug='${slug}' title='${course.title}'`);

  const c = await upsertCourse(slug, course);
  console.log(`  course id: ${c.id}`);

  await deleteVersion(c.id, 1);
  console.log('  cleared previous v1 (if any)');

  const v = await insertVersion(c.id);
  console.log(`  version id: ${v.id}`);

  const mods = await insertModules(v.id, course.modules || []);
  console.log(`  inserted ${mods.length} modules`);

  let totLessons = 0, totPages = 0, totKc = 0;
  const moduleSlugs = [];
  for (const { id: mid, source, slug: mslug } of mods) {
    moduleSlugs.push(mslug);
    const lessons = source.lessons || [];
    await insertLessonsAndPages(mid, lessons);
    totLessons += lessons.length;
    totPages += lessons.reduce((s, l) => s + (l.pages?.length || 0), 0);
    totKc += await insertModuleQuiz(mid, source.knowledge_check);
  }
  console.log(`  inserted ${totLessons} lessons, ${totPages} pages, ${totKc} module-quiz questions`);

  const finalCount = await insertFinalExam(v.id, course.final_exam, moduleSlugs);
  if (finalCount) console.log(`  inserted ${finalCount} final-exam questions`);

  await setCurrentVersion(c.id, v.id);
  console.log(`  set courses.current_version_id = ${v.id}`);
  console.log('DONE.');
}

main().catch(e => { console.error(e); process.exit(1); });
