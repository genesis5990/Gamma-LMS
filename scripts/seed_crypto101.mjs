#!/usr/bin/env node
/**
 * One-shot seed script to import the legacy crypto101 course
 * (public/course_data.json) into the authoring-studio Supabase tables.
 *
 * Idempotent: deletes any existing course with slug='crypto101' (cascades to
 * versions/modules/lessons/pages/quizzes), then re-creates the course, version,
 * 3 modules, 18 lessons, ~61 pages, and ~67 module quiz questions.
 *
 * Usage:
 *   SUPABASE_URL=https://fyacdyarcfgngqetmaoc.supabase.co \
 *   SUPABASE_SERVICE_ROLE_KEY=<service-role-jwt> \
 *   node scripts/seed_crypto101.mjs
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SUPABASE_URL = process.env.SUPABASE_URL?.replace(/\/$/, '');
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const ROBERT_UUID = 'b72286a9-595a-4050-ae42-7f3034a70e80';
const SLUG = 'crypto101';

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

const MODULE_DEFS = [
  { num: 1, slug: 'foundations',      title: 'Cryptocurrency Foundations' },
  { num: 2, slug: 'bitcoin-genesis',  title: 'Bitcoin: Genesis to Reality' },
  { num: 3, slug: 'bitcoin-standard', title: 'The Bitcoin Standard' },
];

async function main() {
  const dataPath = path.join(__dirname, '..', 'public', 'course_data.json');
  const data = JSON.parse(await fs.readFile(dataPath, 'utf8'));

  // 1. Delete any existing crypto101 course (cascades to versions/modules/lessons/pages/quizzes).
  console.log('Removing any existing crypto101 course...');
  const existing = await rest('GET', '/courses', { params: { slug: `eq.${SLUG}`, select: 'id' } });
  if (existing && existing.length) {
    for (const row of existing) {
      console.log(`  deleting course ${row.id}`);
      // First null the current_version_id to avoid FK trouble during version delete.
      await rest('PATCH', '/courses', {
        params: { id: `eq.${row.id}` },
        body: { current_version_id: null },
      });
      await rest('DELETE', '/courses', { params: { id: `eq.${row.id}` } });
    }
  }

  // 2. Create the course.
  console.log('Creating course row...');
  const courseRows = await rest('POST', '/courses', {
    body: {
      slug: SLUG,
      title: 'Crypto 101: Cryptocurrency Fundamentals',
      description: 'Foundational crypto literacy for law enforcement — Bitcoin origins, the Bitcoin Standard, wallets, the public ledger, and law-enforcement challenges.',
      visibility: 'preview',
      tenant_id: null,
      pass_threshold: 80,
      created_by: ROBERT_UUID,
      includes_disclaimer: true,
    },
  });
  const courseId = courseRows[0].id;
  console.log(`  course_id = ${courseId}`);

  // 3. Create the version.
  console.log('Creating course_versions row...');
  const versionRows = await rest('POST', '/course_versions', {
    body: {
      course_id: courseId,
      version_number: 1,
      status: 'published',
      published_at: new Date().toISOString(),
      published_by: ROBERT_UUID,
      created_by: ROBERT_UUID,
      notes: 'Initial migration from static course_data.json (v0.4.42).',
    },
  });
  const versionId = versionRows[0].id;
  console.log(`  course_version_id = ${versionId}`);

  await rest('PATCH', '/courses', {
    params: { id: `eq.${courseId}` },
    body: { current_version_id: versionId },
  });

  // 4. Create the three modules.
  console.log('Creating modules...');
  const moduleByNum = new Map();
  for (const m of MODULE_DEFS) {
    const rows = await rest('POST', '/modules', {
      body: {
        course_version_id: versionId,
        slug: m.slug,
        title: m.title,
        position: m.num,
        has_knowledge_check: true,
      },
    });
    moduleByNum.set(m.num, rows[0].id);
    console.log(`  m${m.num} (${m.slug}) -> ${rows[0].id}`);
  }

  // 5. Iterate lesson_map in order; insert lessons + pages.
  console.log('Creating lessons + pages...');
  const moduleLessonCounter = { 1: 0, 2: 0, 3: 0 };
  const lessonIdByKey = new Map(); // 'm2l1' -> uuid
  let pageCount = 0;
  for (const entry of data.lesson_map) {
    if (entry.type === 'quiz') continue; // become module_quiz_questions rows
    const moduleId = moduleByNum.get(entry.module);
    if (!moduleId) {
      console.warn(`  skip ${entry.id}: unknown module ${entry.module}`);
      continue;
    }
    moduleLessonCounter[entry.module]++;
    const position = moduleLessonCounter[entry.module];
    let title = entry.title || entry.id;
    if (entry.type === 'recap' && !/recap/i.test(title)) {
      title = `${title} (Recap)`;
    }
    const lessonRows = await rest('POST', '/lessons', {
      body: {
        module_id: moduleId,
        slug: entry.id,
        title,
        position,
      },
    });
    const lessonId = lessonRows[0].id;
    lessonIdByKey.set(entry.id, lessonId);

    const pages = data.lessons[entry.id] || [];
    if (!pages.length) {
      console.warn(`  ${entry.id}: no pages in source`);
    }
    // Bulk insert pages for this lesson.
    if (pages.length) {
      const pageBodies = pages.map((p, i) => ({
        lesson_id: lessonId,
        position: i + 1,
        page_type: 'text',
        title: null,
        body_html: typeof p.html === 'string' ? p.html : '',
        audio_url: (p.audio && typeof p.audio === 'string' && p.audio.trim()) ? p.audio : null,
        audio_voice: null,
        audio_generated_at: null,
      }));
      await rest('POST', '/pages', { body: pageBodies, prefer: 'return=minimal' });
      pageCount += pageBodies.length;
    }
    console.log(`  ${entry.id} ('${title}') -> ${pages.length} pages`);
  }

  // 6. Module quiz questions.
  console.log('Creating module_quiz_questions...');
  // Determine module for each quiz key by looking at metadata (or first char of key).
  const quizCountByModule = { 1: 0, 2: 0, 3: 0 };
  const modulePositionCounter = { 1: 0, 2: 0, 3: 0 };
  let totalQuizQuestions = 0;
  let skippedQuestions = 0;
  // Iterate quiz keys in lesson_map order so positions reflect natural order.
  const orderedQuizKeys = [];
  for (const entry of data.lesson_map) {
    if (entry.type === 'lesson' && data.quizzes[entry.id]) {
      orderedQuizKeys.push({ key: entry.id, module: entry.module });
    }
  }
  // Append any quiz keys not present in lesson_map order (defensive).
  for (const key of Object.keys(data.quizzes)) {
    if (!orderedQuizKeys.some(x => x.key === key)) {
      const meta = data.metadata[key];
      const moduleNum = meta?.module ?? Number(key.match(/^m(\d+)/)?.[1]);
      orderedQuizKeys.push({ key, module: moduleNum });
    }
  }

  for (const { key, module: moduleNum } of orderedQuizKeys) {
    const moduleId = moduleByNum.get(moduleNum);
    if (!moduleId) {
      console.warn(`  skip quiz ${key}: unknown module ${moduleNum}`);
      continue;
    }
    const questions = data.quizzes[key] || [];
    const inserts = [];
    for (let i = 0; i < questions.length; i++) {
      const q = questions[i];
      const correct = q.correct;
      const choices = q.choices || [];
      const keys = choices.map(c => c.key);
      if (!correct || !keys.includes(correct)) {
        console.warn(`  SKIP ${key} q${i}: missing/invalid correct=${JSON.stringify(correct)}`);
        skippedQuestions++;
        continue;
      }
      const idx = keys.indexOf(correct);
      if (idx < 0 || idx > 3) {
        console.warn(`  SKIP ${key} q${i}: answer_index ${idx} out of range`);
        skippedQuestions++;
        continue;
      }
      modulePositionCounter[moduleNum]++;
      inserts.push({
        module_id: moduleId,
        position: modulePositionCounter[moduleNum],
        question: q.question || '',
        options: choices.map(c => c.text || ''),
        answer_index: idx,
        reference: q.reference || null,
      });
    }
    if (inserts.length) {
      await rest('POST', '/module_quiz_questions', { body: inserts, prefer: 'return=minimal' });
      quizCountByModule[moduleNum] += inserts.length;
      totalQuizQuestions += inserts.length;
    }
    console.log(`  quiz ${key} (m${moduleNum}): ${inserts.length} questions`);
  }

  console.log('\n=== Summary ===');
  console.log(`course_id:          ${courseId}`);
  console.log(`course_version_id:  ${versionId}`);
  console.log(`modules:            3`);
  console.log(`lessons:            ${moduleLessonCounter[1] + moduleLessonCounter[2] + moduleLessonCounter[3]}`);
  console.log(`  m1: ${moduleLessonCounter[1]}, m2: ${moduleLessonCounter[2]}, m3: ${moduleLessonCounter[3]}`);
  console.log(`pages:              ${pageCount}`);
  console.log(`quiz questions:     ${totalQuizQuestions}`);
  console.log(`  m1: ${quizCountByModule[1]}, m2: ${quizCountByModule[2]}, m3: ${quizCountByModule[3]}`);
  console.log(`skipped questions:  ${skippedQuestions}`);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
