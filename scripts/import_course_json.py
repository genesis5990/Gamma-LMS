#!/usr/bin/env python3
"""
Import an existing .course.json file into the authoring-studio Supabase tables.

Creates (or upserts on slug):
  courses (1 row)
  course_versions (1 row, version_number=1, status='published')
  modules (N rows)
  lessons (N rows)
  pages (N rows)
  module_quiz_questions (N rows from each module's knowledge_check)
  final_exam_questions (N rows from final_exam.questions)

Sets courses.current_version_id = the new version's id.

Idempotent: re-running will UPDATE the existing course's title/etc.,
DELETE the previous version_number=1 (cascades to all child rows),
then re-insert. Use this for re-imports after editing the JSON manually.

Usage:
  SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \\
    python3 scripts/import_course_json.py path/to/course.json [--slug overide]
"""
import argparse
import json
import os
import sys
from urllib import request, parse, error

def env(name):
    v = os.environ.get(name)
    if not v:
        sys.exit(f"missing env: {name}")
    return v

SUPABASE_URL = env('SUPABASE_URL').rstrip('/')
SERVICE_KEY = env('SUPABASE_SERVICE_ROLE_KEY')

HEADERS = {
    'apikey': SERVICE_KEY,
    'Authorization': f'Bearer {SERVICE_KEY}',
    'Content-Type': 'application/json',
    'Prefer': 'return=representation',
}

def rest(method, path, body=None, params=None):
    url = f"{SUPABASE_URL}/rest/v1{path}"
    if params:
        url += '?' + parse.urlencode(params)
    data = json.dumps(body).encode() if body is not None else None
    req = request.Request(url, data=data, method=method, headers=HEADERS)
    try:
        with request.urlopen(req) as r:
            txt = r.read().decode()
            return json.loads(txt) if txt else None
    except error.HTTPError as e:
        body_txt = e.read().decode() if e.fp else ''
        sys.exit(f"HTTP {e.code} {method} {path}: {body_txt}")

def upsert_course(slug, course):
    """Insert or update the courses row by slug. Returns row dict."""
    payload = {
        'slug': slug,
        'title': course.get('title'),
        'description': course.get('description'),
        'audience': course.get('audience'),
        'prerequisites': course.get('prerequisites'),
        'pass_threshold': int(course.get('pass_threshold', 80)),
        'includes_disclaimer': bool(course.get('includes_disclaimer', False)),
        'visibility': 'preview',
    }
    # Upsert via on_conflict=slug
    rows = rest('POST', '/courses',
                params={'on_conflict': 'slug'},
                body=payload)
    # PostgREST returns the row(s)
    if isinstance(rows, list) and rows:
        return rows[0]
    # Fallback: select
    rows = rest('GET', '/courses', params={'slug': f'eq.{slug}', 'select': '*'})
    return rows[0]

def delete_version(course_id, version_number):
    """Delete an existing version row (cascades to modules/lessons/pages/quizzes)."""
    rest('DELETE', '/course_versions',
         params={
             'course_id': f'eq.{course_id}',
             'version_number': f'eq.{version_number}',
         })

def insert_version(course_id):
    rows = rest('POST', '/course_versions', body={
        'course_id': course_id,
        'version_number': 1,
        'status': 'published',
        'notes': 'Imported from .course.json (initial seed)',
    })
    return rows[0]

def insert_modules(version_id, modules):
    """Insert modules and return list of (module_id, source_module_dict, slug)."""
    rows = []
    for idx, m in enumerate(modules):
        slug = m.get('id') or f'm{idx}'
        kc = m.get('knowledge_check')
        has_kc = bool(kc and kc.get('questions'))
        payload = {
            'course_version_id': version_id,
            'slug': slug,
            'title': m.get('title', ''),
            'description': m.get('description'),
            'position': idx,
            'has_knowledge_check': has_kc,
        }
        ins = rest('POST', '/modules', body=payload)[0]
        rows.append((ins['id'], m, slug))
    return rows

def insert_lessons_and_pages(module_id, lessons):
    for li, l in enumerate(lessons):
        slug = l.get('id') or f'lesson-{li}'
        lesson = rest('POST', '/lessons', body={
            'module_id': module_id,
            'slug': slug,
            'title': l.get('title', ''),
            'position': li,
        })[0]
        for pi, p in enumerate(l.get('pages', [])):
            rest('POST', '/pages', body={
                'lesson_id': lesson['id'],
                'position': pi,
                'page_type': p.get('type', 'text'),
                'title': p.get('title'),
                'body_html': p.get('content', ''),
            })

def insert_module_quiz(module_id, kc):
    if not kc or not kc.get('questions'): return
    for qi, q in enumerate(kc['questions']):
        rest('POST', '/module_quiz_questions', body={
            'module_id': module_id,
            'position': qi,
            'question': q.get('q', ''),
            'options': q.get('options', []),
            'answer_index': int(q.get('answer', 0)),
            'reference': q.get('ref'),
        })

def insert_final_exam(version_id, final_exam, module_slug_lookup):
    if not final_exam or not final_exam.get('questions'): return
    for qi, q in enumerate(final_exam['questions']):
        # Best-effort source_module_slug from 'ref' field e.g. "Module 2.1"
        ref = q.get('ref', '')
        src_slug = None
        if ref:
            for slug in module_slug_lookup:
                if slug in ref or slug.replace('-', ' ') in ref.lower():
                    src_slug = slug
                    break
        rest('POST', '/final_exam_questions', body={
            'course_version_id': version_id,
            'position': qi,
            'question': q.get('q', ''),
            'options': q.get('options', []),
            'answer_index': int(q.get('answer', 0)),
            'reference': ref,
            'source_module_slug': src_slug,
        })

def set_current_version(course_id, version_id):
    rest('PATCH', '/courses',
         params={'id': f'eq.{course_id}'},
         body={'current_version_id': version_id})

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('path', help='path to .course.json')
    ap.add_argument('--slug', help='override slug (default: course.id field, else filename stem)')
    args = ap.parse_args()

    with open(args.path) as f:
        course = json.load(f)

    slug = args.slug or course.get('id') or os.path.splitext(os.path.basename(args.path))[0].replace('.course','')
    print(f"Importing slug='{slug}' title='{course.get('title')}'")

    crow = upsert_course(slug, course)
    print(f"  course id: {crow['id']}")

    delete_version(crow['id'], 1)
    print("  cleared previous v1 (if any)")

    vrow = insert_version(crow['id'])
    print(f"  version id: {vrow['id']}")

    mods = insert_modules(vrow['id'], course.get('modules', []))
    print(f"  inserted {len(mods)} modules")

    total_lessons = total_pages = total_kc = 0
    module_slugs = []
    for mid, mdict, mslug in mods:
        module_slugs.append(mslug)
        lessons = mdict.get('lessons', [])
        insert_lessons_and_pages(mid, lessons)
        total_lessons += len(lessons)
        total_pages += sum(len(l.get('pages', [])) for l in lessons)
        kc = mdict.get('knowledge_check')
        if kc and kc.get('questions'):
            insert_module_quiz(mid, kc)
            total_kc += len(kc['questions'])
    print(f"  inserted {total_lessons} lessons, {total_pages} pages, {total_kc} module-quiz questions")

    final = course.get('final_exam')
    if final and final.get('questions'):
        insert_final_exam(vrow['id'], final, module_slugs)
        print(f"  inserted {len(final['questions'])} final-exam questions")

    set_current_version(crow['id'], vrow['id'])
    print(f"  set courses.current_version_id = {vrow['id']}")

    print("DONE.")

if __name__ == '__main__':
    main()
