#!/usr/bin/env node
/**
 * Generates docs/MAP.md — the map of the program, read straight from the code:
 * every module with its app, dependencies, permissions, role templates, tables,
 * services, events, HTTP routes and files, plus the web modules and their pages.
 *
 *   npm run docs:map            → rewrite docs/MAP.md
 *   npm run docs:map -- --check → exit 1 if docs/MAP.md is out of date (used by the tests)
 *
 * Never edit docs/MAP.md by hand; change the code and run this.
 */
import { readdirSync, readFileSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = resolve(import.meta.dirname, '..');
const SERVER = join(ROOT, 'apps/server/src');
const WEB = join(ROOT, 'apps/web/src');
const OUT = join(ROOT, 'docs/MAP.md');

const walk = (dir, re = /\.tsx?$/) =>
  existsSync(dir)
    ? readdirSync(dir)
        .sort()
        .flatMap((f) => {
          const p = join(dir, f);
          return statSync(p).isDirectory() ? walk(p, re) : re.test(p) ? [p] : [];
        })
    : [];
const read = (f) => readFileSync(f, 'utf8');
const lines = (f) => read(f).split('\n').length;
const uniq = (a) => [...new Set(a)].sort();
const code = (a) => (a.length ? a.map((x) => '`' + x + '`').join(', ') : '—');
const rel = (f) => relative(ROOT, f).split('\\').join('/');

async function serverModules() {
  const { modules } = await import(pathToFileURL(join(SERVER, 'modules/index.ts')).href);
  const { sortModules } = await import(pathToFileURL(join(SERVER, 'kernel/modules.ts')).href);
  return sortModules(modules).map((m) => {
    const dir = join(SERVER, 'modules', m.id);
    const files = walk(dir).filter((f) => !f.endsWith('.test.ts'));
    const src = files.map(read).join('\n');
    const sql = (m.migrations ?? []).map((x) => x.up).join('\n');
    const routes = [...src.matchAll(/\br\.(get|post|put|delete)\(\s*[`']([^`']+)[`'],\s*'([^']+)'/g)].map((x) => ({ method: x[1].toUpperCase(), path: '/api' + x[2], perm: x[3] }));
    return {
      id: m.id,
      dir: rel(dir),
      dependsOn: m.dependsOn ?? [],
      apps: (m.apps ?? []).map((a) => ({ id: a.id, core: !!a.core, requires: a.requires ?? [], prefixes: a.permissions ?? [] })),
      permissions: m.permissions ?? [],
      roles: (m.roles ?? []).map((r) => r.id),
      sod: (m.sod ?? []).map(([a, b]) => `${a} × ${b}`),
      tables: uniq([...sql.matchAll(/CREATE\s+(?:TABLE|VIEW)\s+(?:IF NOT EXISTS\s+)?(\w+)/gi)].map((x) => x[1])),
      provides: uniq([...src.matchAll(/services\.provide\('(\w+)'/g)].map((x) => x[1])),
      emits: uniq([...src.matchAll(/events\.emit\('([\w.]+)'/g)].map((x) => x[1])),
      listens: uniq([...src.matchAll(/events\.on\('([\w.]+)'/g)].map((x) => x[1])),
      health: !!m.health,
      routes,
      files: files.map((f) => ({ path: rel(f), lines: lines(f) })),
    };
  });
}

function webModules() {
  const dir = join(WEB, 'modules');
  if (!existsSync(dir)) return [];
  const listed = [...read(join(dir, 'index.ts')).matchAll(/from '\.\/([\w-]+)'/g)].map((x) => x[1]);
  return listed.map((id) => {
    const files = walk(join(dir, id));
    const src = files.map(read).join('\n');
    return {
      id,
      dir: rel(join(dir, id)),
      pages: uniq([...src.matchAll(/\{\s*path:\s*'([^']+)'/g)].map((x) => x[1])),
      apps: uniq([...src.matchAll(/\bapp:\s*'(\w+)'/g)].map((x) => x[1])),
      files: files.map((f) => ({ path: rel(f), lines: lines(f) })),
    };
  });
}

function folder(dir, note) {
  const files = walk(dir);
  return files.length ? `| \`${rel(dir)}/\` | ${files.length} | ${note} |` : '';
}

export async function render() {
  const mods = await serverModules();
  const web = webModules();
  const o = [];
  o.push('# Program map', '');
  o.push('> **Generated from the code by `npm run docs:map` — do not edit by hand.**');
  o.push('> A test fails when this file is out of date, so it always matches the code.', '');
  o.push('Where to find things: pick the module, then the file. Modules talk only through');
  o.push('`kernel/`, `contracts/`, services and events (see [ARCHITECTURE](ARCHITECTURE.md)).', '');

  o.push('## Apps → modules', '');
  o.push('| App | Server modules | Needs | Permission prefixes |', '|---|---|---|---|');
  const apps = new Map();
  for (const m of mods)
    for (const a of m.apps) {
      const cur = apps.get(a.id) ?? { mods: [], requires: new Set(), prefixes: new Set(), core: false };
      cur.mods.push(m.id);
      a.requires.forEach((r) => cur.requires.add(r));
      a.prefixes.forEach((p) => cur.prefixes.add(p));
      cur.core ||= a.core;
      apps.set(a.id, cur);
    }
  for (const [id, a] of apps) o.push(`| **${id}**${a.core ? ' (core)' : ''} | ${code(a.mods)} | ${code([...a.requires])} | ${code([...a.prefixes])} |`);
  o.push('', 'Engines (no app of their own, pulled in by `dependsOn`): ' + code(mods.filter((m) => !m.apps.length).map((m) => m.id)), '');

  o.push('## Server layout', '');
  o.push('| Folder | Files | What lives there |', '|---|---|---|');
  o.push(folder(join(SERVER, 'kernel'), 'the chassis: db adapter, module loader, services, events, apps, money, dates, validation'));
  o.push(folder(join(SERVER, 'contracts'), 'shared types and constants modules use to talk to each other'));
  o.push(folder(join(SERVER, 'modules'), 'one folder per module (below)'));
  o.push(folder(join(SERVER, 'test'), 'end-to-end tests, boundary and edition tests'));
  o.push('');
  o.push('Contracts: ' + code(walk(join(SERVER, 'contracts')).map((f) => rel(f).split('/').pop())), '');

  o.push('## Server modules (in load order)', '');
  for (const m of mods) {
    o.push(`### \`${m.id}\` — ${m.dir}/`, '');
    o.push(`- **Apps:** ${code(m.apps.map((a) => a.id))} · **Depends on:** ${code(m.dependsOn)} · **Health checks:** ${m.health ? 'yes' : 'no'}`);
    o.push(`- **Permissions:** ${code(m.permissions)}`);
    if (m.roles.length) o.push(`- **Role templates:** ${code(m.roles)}`);
    if (m.sod.length) o.push(`- **Duties to split:** ${code(m.sod)}`);
    o.push(`- **Tables / views:** ${code(m.tables)}`);
    o.push(`- **Provides services:** ${code(m.provides)}`);
    if (m.emits.length || m.listens.length) o.push(`- **Events:** emits ${code(m.emits)} · listens ${code(m.listens)}`);
    o.push(`- **Files:** ${m.files.map((f) => `\`${f.path.split('/').pop()}\` (${f.lines})`).join(', ')}`);
    if (m.routes.length) {
      o.push('', '<details><summary>' + m.routes.length + ' routes</summary>', '', '| Method | Path | Permission |', '|---|---|---|');
      for (const r of m.routes) o.push(`| ${r.method} | \`${r.path}\` | \`${r.perm}\` |`);
      o.push('', '</details>');
    }
    o.push('');
  }

  o.push('## Web layout', '');
  o.push('| Folder | Files | What lives there |', '|---|---|---|');
  o.push(folder(join(WEB, 'core'), 'session, API client, i18n (en/ar dictionaries), formatting, module registry'));
  o.push(folder(join(WEB, 'ui'), 'design-system widgets shared by every module (DataGrid, pickers, dialogs, stock, cost centers)'));
  o.push(folder(join(WEB, 'engines'), 'shared screens used by several apps (documents, parties)'));
  o.push(folder(join(WEB, 'shell'), 'sidebar / top bar, command palette, layout'));
  o.push(folder(join(WEB, 'styles'), 'tokens, base and component CSS'));
  o.push('');
  o.push('## Web modules', '');
  o.push('| Module | Apps | Pages | Files |', '|---|---|---|---|');
  for (const w of web) o.push(`| \`${w.id}\` | ${code(w.apps)} | ${code(w.pages)} | ${w.files.length} (${w.files.reduce((s, f) => s + f.lines, 0)} lines) |`);
  o.push('');
  return o.filter((l, i, a) => !(l === '' && a[i - 1] === '')).join('\n');
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const text = await render();
  if (process.argv.includes('--check')) {
    // A Windows checkout (core.autocrlf) turns LF into CRLF; that is not a stale map.
    const cur = existsSync(OUT) ? read(OUT).replace(/\r\n/g, '\n') : '';
    if (cur !== text) {
      console.error('docs/MAP.md is out of date — run: npm run docs:map');
      process.exit(1);
    }
    console.log('docs/MAP.md is up to date');
  } else {
    writeFileSync(OUT, text);
    console.log('docs/MAP.md written');
  }
}
