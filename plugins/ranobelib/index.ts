// RanobeLib (ranobelib.me) through its JSON API api.cdnlibs.org. SOURCES_DESIGN.md §7.
//
// Book id = slug_url ("19232--mother-of-learning"): the API does not accept the bare number.
// A chapter can exist in several translations (branches). For each book the plugin picks one branch, the one with
// the most chapters, remembers it in storage (so chapter ids stay stable when another team appears) and takes every
// chapter from it, falling back to the first branch that has the chapter. The host may pin a branch itself by
// writing storage "branch:<bookId>" before chapters() (Unison Studio keeps the team of an already voiced book);
// details(bookId, {branches: true}) lists the branches with their teams and chapter counts for that choice.
// Chapters are listed in reading order: by volume, then by chapter number compared part by part as integers
// ("0.2" < "0.10", "5" < "5.0"). The API's own "index" puts "0.10" before "0.2" (it compares the numbers as text).
// Text: a translator's notes block at the end ("Примечания", "•Примечание.•", "Сноски") is not part of the chapter,
// and a first paragraph that only repeats the chapter title is dropped (it would be read twice).
// Chapter id = "<volume>/<number>" plus "@<branch>" when the branch is not null, e.g. "1/5@17824".
// Text comes either as HTML or as ProseMirror JSON (core.prosemirrorToHtml). Images use site-relative links.
// Chapters of 18+ books are 404 without login: then the plugin asks to log in (NEEDS_LOGIN).

import manifest from "./manifest.json";
import { definePlugin, fetch, fail, storage } from "../../base/lib/runtime";
import { parseChapterHtml, prosemirrorToHtml, isPmDoc, parseUrl, normalizeSpaces } from "../../base/lib/core";
import type { PmNode } from "../../base/lib/core";
import type { BookDetails, BookStub, ChapterStub, Filter, FilterValues, Manifest, Page } from "../../base/lib/types";

const API = "https://api.cdnlibs.org/api";
const SITE = "https://ranobelib.me";
const HEADERS = { Accept: "application/json", "Site-Id": "3", Referer: SITE + "/" };
const ADULT_AGE = 4;               // ageRestriction ids: 1 6+, 2 12+, 3 16+, 4 18+, 5 18+ (RX)

type Q = [string, string | number][];

function qs(params: Q): string {
  return params.map(([k, v]) => k + "=" + encodeURIComponent(String(v))).join("&");
}

/** GET a JSON API path; null on 404. */
async function api(path: string): Promise<any | null> {
  const url = API + path;
  const r = await fetch(url, { headers: HEADERS });
  if (r.status === 404) return null;
  if (r.status === 429) fail("RATE_LIMITED", "RanobeLib API 429");
  if (r.status === 401) fail("NEEDS_LOGIN", "Войдите в RanobeLib снова");
  if (r.status === 403 && !/json/.test(r.headers["content-type"] || "")) fail("NEEDS_BROWSER", "Проверка защиты сайта", SITE + "/ru");
  if (r.status >= 500) fail("UNAVAILABLE", `RanobeLib API ${r.status}`, url);
  if (r.status !== 200) fail("CHANGED_LAYOUT", `HTTP ${r.status}`, url);
  try { return JSON.parse(r.text); } catch { fail("CHANGED_LAYOUT", "not JSON", url); }
}

const titleOf = (b: any): string => normalizeSpaces(b.rus_name || b.eng_name || b.name || String(b.id));
const isAdult = (b: any): boolean => (b.ageRestriction?.id ?? 0) >= ADULT_AGE;

function stub(b: any): BookStub {
  const s: BookStub = { id: String(b.slug_url || b.id + "--" + b.slug), title: titleOf(b) };
  if (b.cover?.default) s.cover = b.cover.default;
  if (isAdult(b)) s.nsfw = true;
  return s;
}

async function list(params: Q, page: number): Promise<Page<BookStub>> {
  const d = await api("/manga?" + qs([["site_id[]", 3], ...params, ["page", page]]));
  if (!d || !Array.isArray(d.data)) fail("CHANGED_LAYOUT", "no book list");
  return { items: d.data.map(stub), hasNext: !!d.meta?.has_next_page };
}

function filterParams(f: FilterValues | undefined, defaultSort: string): Q {
  const out: Q = [];
  const sort = typeof f?.sort === "string" && f.sort ? f.sort : defaultSort;
  out.push(["sort_by", sort.replace(/^-/, "")], ["sort_type", sort.startsWith("-") ? "desc" : "asc"]);
  for (const [id, key] of [["types", "types[]"], ["genres", "genres[]"], ["status", "manga_status[]"], ["translation", "scanlateStatus[]"]]) {
    const v = f?.[id];
    for (const x of Array.isArray(v) ? v : typeof v === "string" && v ? [v] : []) out.push([key, x]);
  }
  if (f?.withChapters !== false) out.push(["chapters[min]", 1]);
  return out;
}

/** Book summary: HTML or ProseMirror → plain text with paragraphs. */
function summaryText(s: unknown): string | undefined {
  const html = typeof s === "string" ? s : isPmDoc(s) ? prosemirrorToHtml(s) : "";
  if (!html) return undefined;
  const { paras } = parseChapterHtml(html, { lang: "ru", titleFromHeading: false });
  return paras.length ? paras.join("\n\n") : undefined;
}

function status(d: any): BookDetails["status"] {
  const tr = d.scanlateStatus?.id, ti = d.status?.id;
  if (tr === 1) return "ongoing";                     // the translation goes on
  if (tr === 2 && ti === 2) return "completed";       // the title and its translation are finished
  if (ti === 1) return "ongoing";
  return "unknown";
}

const iso = (s: unknown): string | undefined =>
  typeof s === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d/.test(s) ? s.slice(0, 19) + "Z" : undefined;

const bookUrl = (id: string) => SITE + "/ru/book/" + id;
const chapterUrl = (id: string, v: string, n: string, b: string | null) =>
  SITE + "/ru/" + id + "/read/v" + encodeURIComponent(v) + "/c" + encodeURIComponent(n) + (b ? "?bid=" + b : "");

function parseChapterId(chapterId: string): { volume: string; number: string; branch: string | null } {
  const m = /^([^/@]+)\/([^/@]+)(?:@(\d+))?$/.exec(chapterId);
  if (!m) fail("NOT_FOUND", "bad chapter id " + chapterId);
  return { volume: m[1], number: m[2], branch: m[3] || null };
}

const chapterTitle = (number: string, name: unknown) =>
  "Глава " + number + (typeof name === "string" && normalizeSpaces(name) ? ". " + normalizeSpaces(name) : "");

const branchKey = (b: unknown) => (b === null || b === undefined ? "" : String(b));

const NOTES = /^[\s•*·]*(примечани[еяй]|сноск[аи])(\s+(переводчик[аов]*|редактор[аов]*))?[\s.:…•*·]*$/i;
const bare = (s: string) => s.toLowerCase().replace(/ё/g, "е").replace(/[^a-zа-я0-9]+/g, "");

interface Branch { id: string; teams: string; chapters: number }

/** Branches of a book with their teams, most chapters first (ids as in chapter ids, "" = no branch). */
function branchesOf(chs: any[]): Branch[] {
  const m = new Map<string, { teams: string[]; chapters: number }>();
  for (const c of chs) for (const b of c.branches || []) {
    const k = branchKey(b.branch_id);
    const e = m.get(k) || { teams: [], chapters: 0 };
    e.chapters++;
    for (const t of b.teams || []) if (t?.name && !e.teams.includes(String(t.name))) e.teams.push(String(t.name));
    m.set(k, e);
  }
  return [...m.entries()].map(([id, e]) => ({ id, teams: e.teams.join(", "), chapters: e.chapters }))
    .sort((a, b) => b.chapters - a.chapters || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** The chapter list of the API in reading order. */
async function chapterList(bookId: string): Promise<any[]> {
  const d = await api("/manga/" + encodeURIComponent(bookId) + "/chapters");
  if (!d) fail("NOT_FOUND", "no such book", bookUrl(bookId));
  if (!Array.isArray(d.data)) fail("CHANGED_LAYOUT", "no chapter list");
  const chs: any[] = d.data.filter((c: any) => Array.isArray(c.branches) && c.branches.length);
  // stable: chapters whose volume and number compare equal keep the API's order
  return chs.map((c, i) => [c, i] as [any, number])
    .sort((a, b) => compareParts(String(a[0].volume), String(b[0].volume)) || compareParts(String(a[0].number), String(b[0].number)) || a[1] - b[1])
    .map((x) => x[0]);
}

/** "0.2" < "0.10" < "1", "5" < "5.0" < "5.1": parts as integers, a shorter prefix first; non-numbers last, as text. */
export function compareParts(a: string, b: string): number {
  const pa = a.split("."), pb = b.split(".");
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if (i >= pa.length) return -1;
    if (i >= pb.length) return 1;
    const na = /^\d+$/.test(pa[i]) ? Number(pa[i]) : NaN, nb = /^\d+$/.test(pb[i]) ? Number(pb[i]) : NaN;
    if (!isNaN(na) && !isNaN(nb)) { if (na !== nb) return na - nb; continue; }
    if (isNaN(na) !== isNaN(nb)) return isNaN(na) ? 1 : -1;
    if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  }
  return 0;
}

/** Notes at the end and a repeated title at the start are not read aloud. */
function cleanText(title: string, name: unknown, paras: string[], images: { after: number }[]) {
  let cut = -1;
  for (let i = paras.length - 1; i >= 0; i--) if (NOTES.test(paras[i])) { cut = i; break; }
  if (cut >= 0) {
    paras = paras.slice(0, cut);
    for (const im of images) if (im.after > paras.length - 1) im.after = paras.length - 1;
  }
  const first = paras.length ? bare(paras[0]) : "";
  const nm = typeof name === "string" ? bare(name) : "";
  if (first && paras.length > 1 && (first === bare(title) || (nm && first === nm))) {
    paras = paras.slice(1);
    for (const im of images) im.after = Math.max(-1, im.after - 1);
  }
  return paras;
}

const plugin = {
  popular: (page: number, filters?: FilterValues) => list(filterParams(filters, "-rating_score"), page),

  latest: (page: number) => list([["sort_by", "last_chapter_at"], ["sort_type", "desc"], ["chapters[min]", 1]], page),

  search: (query: string, page: number, filters?: FilterValues) =>
    list([["q", query], ...filterParams(filters, "-rating_score")], page),

  async filters(): Promise<Filter[]> {
    const d = await api("/constants?" + qs([["fields[]", "genres"], ["fields[]", "types"], ["fields[]", "status"], ["fields[]", "scanlateStatus"]]));
    if (!d?.data) fail("CHANGED_LAYOUT", "no constants");
    const forSite = (xs: any[]) => (xs || []).filter((x) => (x.site_ids || []).includes(3));
    const opts = (xs: any[]) => forSite(xs).map((x) => ({ id: String(x.id), title: String(x.label || x.name) }));
    return [
      { id: "sort", title: "Сортировка", type: "sort", default: "-rating_score", options: [
        { id: "rating_score", title: "По популярности" }, { id: "rate_avg", title: "По рейтингу" },
        { id: "views", title: "По просмотрам" }, { id: "chap_count", title: "По количеству глав" },
        { id: "last_chapter_at", title: "По дате обновления" }, { id: "created_at", title: "По дате добавления" },
        { id: "rus_name", title: "По названию" }] },
      { id: "types", title: "Тип", type: "multiselect", options: opts(d.data.types) },
      { id: "genres", title: "Жанры", type: "multiselect", options: opts(d.data.genres) },
      { id: "status", title: "Статус тайтла", type: "multiselect", options: opts(d.data.status) },
      { id: "translation", title: "Статус перевода", type: "multiselect", options: opts(d.data.scanlateStatus) },
      { id: "withChapters", title: "Только с главами", type: "toggle", default: true },
    ];
  },

  async details(bookId: string, opts?: { branches?: boolean }): Promise<BookDetails> {
    const fields = ["summary", "genres", "tags", "teams", "authors", "status_id"];
    const d = (await api("/manga/" + encodeURIComponent(bookId) + "?" + qs(fields.map((f) => ["fields[]", f]))))?.data;
    if (!d) fail("NOT_FOUND", "no such book", bookUrl(bookId));
    const out: BookDetails = {
      id: bookId, title: titleOf(d), tags: [...new Set([...(d.genres || []), ...(d.tags || [])].map((t: any) => String(t.name)).filter(Boolean))],
      status: status(d), lang: "ru", url: bookUrl(bookId),
    };
    const authors = (d.authors || []).map((a: any) => a.name).filter(Boolean);
    if (authors.length) out.author = authors.join(", ");
    const teams = (d.teams || []).map((t: any) => t.name).filter(Boolean);
    if (teams.length) out.translator = teams.join(", ");
    if (d.cover?.default) out.cover = d.cover.default;
    const desc = summaryText(d.summary);
    if (desc) out.description = desc;
    if (isAdult(d)) out.nsfw = true;
    if (opts?.branches) (out as BookDetails & { branches: Branch[] }).branches = branchesOf(await chapterList(bookId));
    return out;
  },

  async chapters(bookId: string): Promise<ChapterStub[]> {
    const chs = await chapterList(bookId);

    // one branch for the whole book, chosen once
    const key = "branch:" + bookId;
    let main = await storage.get<string>(key);
    if (main === null || !chs.some((c) => c.branches.some((b: any) => branchKey(b.branch_id) === main))) {
      const count = new Map<string, number>();
      for (const c of chs) for (const b of c.branches) count.set(branchKey(b.branch_id), (count.get(branchKey(b.branch_id)) || 0) + 1);
      main = [...count.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))[0]?.[0] ?? "";
      await storage.set(key, main);
    }

    const volumes = new Set(chs.map((c) => String(c.volume)));
    return chs.map((c) => {
      const b = c.branches.find((x: any) => branchKey(x.branch_id) === main) || c.branches[0];
      const v = String(c.volume), n = String(c.number), bid = branchKey(b.branch_id) || null;
      const s: ChapterStub = { id: v + "/" + n + (bid ? "@" + bid : ""), title: chapterTitle(n, c.name), url: chapterUrl(bookId, v, n, bid) };
      if (volumes.size > 1) s.volume = "Том " + v;
      const date = iso(b.created_at);
      if (date) s.date = date;
      return s;
    });
  },

  async chapter(bookId: string, chapterId: string) {
    const { volume, number, branch } = parseChapterId(chapterId);
    const params: Q = [["number", number], ["volume", volume]];
    if (branch) params.unshift(["branch_id", branch]);
    const url = chapterUrl(bookId, volume, number, branch);
    const res = await api("/manga/" + encodeURIComponent(bookId) + "/chapter?" + qs(params));
    if (!res) {
      // 18+ chapters are hidden without login; anything else is really gone
      const book = (await api("/manga/" + encodeURIComponent(bookId)))?.data;
      if (book && isAdult(book)) fail("NEEDS_LOGIN", "Глава 18+: войдите в RanobeLib", url);
      fail("NOT_FOUND", "no such chapter", url);
    }
    const d = res.data;
    const atts: any[] = Array.isArray(d.attachments) ? d.attachments : [];
    const abs = (u: string) => (/^https?:\/\//.test(u) ? u : SITE + (u.startsWith("/") ? "" : "/") + u);
    let html: string;
    if (isPmDoc(d.content)) {
      html = prosemirrorToHtml(d.content as PmNode, (n) => {
        const refs = ((n.attrs?.images as { image: string | number }[]) || []).map((x) => String(x.image));
        const found = refs.map((r) => atts.find((a) => String(a.name) === r || String(a.id) === r)).filter(Boolean);
        if (!found.length && typeof n.attrs?.src === "string") return [{ src: abs(n.attrs.src as string) }];
        return found.map((a) => ({ src: abs(String(a.url)), w: a.width || undefined, h: a.height || undefined }));
      });
    } else if (typeof d.content === "string") html = d.content;
    else fail("CHANGED_LAYOUT", "unknown chapter content", url);
    const title = chapterTitle(String(d.number ?? number), d.name);
    const parsed = parseChapterHtml(html, { lang: "ru", titleFromHeading: false, fallbackTitle: title, baseUrl: SITE + "/" });
    const paras = cleanText(title, d.name, parsed.paras, parsed.images);
    return { kind: "text" as const, title, paras, images: parsed.images };
  },

  async bookIdFromUrl(url: string): Promise<string | null> {
    const u = parseUrl(url);
    if (!u || !/(^|\.)ranobelib\.me$/.test(u.host)) return null;
    // /ru/book/<slug_url>, /ru/<slug_url>/read/…, /book/<slug_url>
    const m = /^\/(?:[a-z]{2}\/)?(?:book\/)?(\d+--[^/?#]+)/.exec(u.pathname);
    return m ? decodeURIComponent(m[1]) : null;
  },
};

definePlugin(manifest as Manifest, plugin);
