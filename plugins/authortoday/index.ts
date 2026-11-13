// Author.Today (author.today): HTML catalog and book pages, chapter text from the reader's JSON. SOURCES_DESIGN.md §7.
//
// robots.txt closes /search and query filters (?form=, ?category=, …) for robots. The catalog is browsed by genre
// and form in the path (/work/genre/<genre>/ebook/<form>) with ?sorting=. Search runs only when the user types a query
// (decided 12.11.2026: a user's request, like in a browser), never in the background or the nightly smoke test. Book id = work number ("677832"). Chapter id = chapter number; a work without a table of contents
// (a short story) has one chapter "0"; a paid chapter the account cannot read has no link on the site, so its id is
// "~" + its title and it is marked locked.
// Chapter text is XOR-encrypted: key = reversed Reader-Secret response header + "@_@" + userId (empty for a guest),
// userId comes from the reader page. Login = the site's cookies (§19.2), so bought chapters open too.

import manifest from "./manifest.json";
import { definePlugin, fetch, fail } from "../../base/lib/runtime";
import { parseChapterHtml, normalizeSpaces, parseUrl, classes } from "../../base/lib/core";
import type { BookDetails, BookStub, ChapterStub, Filter, FilterValues, Manifest, Page } from "../../base/lib/types";
import { parseDocument, DomUtils } from "htmlparser2";
import type { Element } from "domhandler";

const SITE = "https://author.today";
// After a login in the phone's WebView the site sets mobile-mode=true and then serves its mobile pages to every
// request with those cookies; the plugin reads the desktop markup, so it always asks for it (the host merges cookies).
const DESKTOP = { Cookie: "mobile-mode=false" };

async function page(url: string): Promise<{ doc: ReturnType<typeof parseDocument>; html: string }> {
  const r = await fetch(url, { headers: DESKTOP });
  if (r.status === 404) fail("NOT_FOUND", "no such page", url);
  if (r.status === 429) fail("RATE_LIMITED", "Author.Today 429");
  if (r.status === 403 && !/text\/html/.test(r.headers["content-type"] || "") ) fail("NEEDS_BROWSER", "Проверка защиты сайта", url);
  if (r.status >= 500) fail("UNAVAILABLE", `Author.Today ${r.status}`, url);
  if (r.status !== 200) fail("CHANGED_LAYOUT", `HTTP ${r.status}`, url);
  if (/ddos-guard|checking your browser/i.test(r.text.slice(0, 3000)) && !/book-row|book-meta-panel|reader/.test(r.text)) fail("NEEDS_BROWSER", "Проверка защиты сайта", url);
  return { doc: parseDocument(r.text, { decodeEntities: true }), html: r.text };
}

const has = (el: Element, c: string) => classes(el).includes(c);
const find = (nodes: any, test: (e: Element) => boolean) => DomUtils.findOne(test, Array.isArray(nodes) ? nodes : [nodes], true);
const findAll = (nodes: any, test: (e: Element) => boolean) => DomUtils.findAll(test, Array.isArray(nodes) ? nodes : [nodes]);
const text = (n: any) => (n ? normalizeSpaces(DomUtils.textContent(n)) : "");
const workId = (href: string | undefined) => /\/work\/(\d+)/.exec(href || "")?.[1];

const ADULT = /эрот/i;

/** Catalog and search-result cards: div.book-row. */
function cards(doc: any): BookStub[] {
  const out: BookStub[] = [];
  const seen = new Set<string>();
  for (const row of findAll(doc.children, (e) => e.name === "div" && has(e, "book-row"))) {
    const titleA = find(row, (e) => e.name === "a" && !!workId(e.attribs.href) && !!e.parent && has(e.parent as Element, "book-title"));
    const id = workId(titleA?.attribs.href);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const s: BookStub = { id, title: text(titleA) };
    const img = find(row, (e) => e.name === "img" && !!e.parent && has(e.parent as Element, "cover-image"));
    const src = img?.attribs.src || img?.attribs["data-src"];
    if (src) s.cover = src.replace(/&amp;/g, "&");
    const authors = findAll(row, (e) => e.name === "a" && !!e.parent && has(e.parent as Element, "book-author")).map(text).filter(Boolean);
    if (authors.length) s.author = authors.join(", ");
    if (ADULT.test(text(find(row, (e) => has(e, "book-genres"))))) s.nsfw = true;
    out.push(s);
  }
  return out;
}

function hasNextPage(doc: any): boolean {
  return !!find(doc.children, (e) => (e.name === "a" || e.name === "link") && e.attribs.rel === "next");
}

const FORMS = [
  { id: "novel", title: "Роман" }, { id: "tale", title: "Повесть" }, { id: "story", title: "Рассказ" },
  { id: "story-book", title: "Сборник рассказов" }, { id: "poetry", title: "Сборник поэзии" }, { id: "translation", title: "Перевод" },
];
const SORTS = [
  { id: "popular", title: "По популярности" }, { id: "trending", title: "Набирающие популярность" },
  { id: "likes", title: "По лайкам" }, { id: "views", title: "По просмотрам" }, { id: "comments", title: "По комментариям" },
  { id: "recent", title: "Новинки" }, { id: "updated", title: "По обновлениям" },
];

function catalogUrl(f: FilterValues | undefined, sorting: string, n: number): string {
  const genre = typeof f?.genre === "string" && /^[a-z0-9-]+$/.test(f.genre) ? f.genre : "all";
  const form = typeof f?.form === "string" && FORMS.some((x) => x.id === f.form) ? "/" + f.form : "";
  const q: string[] = [];
  if (sorting && sorting !== "popular") q.push("sorting=" + encodeURIComponent(sorting));
  if (n > 1) q.push("page=" + n);
  return `${SITE}/work/genre/${genre}/ebook${form}` + (q.length ? "?" + q.join("&") : "");
}

async function list(url: string): Promise<Page<BookStub>> {
  const { doc } = await page(url);
  const items = cards(doc);
  if (!items.length && !find(doc.children, (e) => has(e, "book-row"))) {
    // an empty page past the end is fine; a page without the catalog markup is not
    if (!find(doc.children, (e) => e.name === "div" && (has(e, "panel-body") || has(e, "book-list")))) fail("CHANGED_LAYOUT", "no catalog", url);
  }
  return { items, hasNext: items.length > 0 && hasNextPage(doc) };
}

function decrypt(enc: string, secret: string, userId: string): string {
  const key = secret.split("").reverse().join("") + "@_@" + userId;
  let out = "";
  for (let i = 0; i < enc.length; i++) out += String.fromCharCode(enc.charCodeAt(i) ^ key.charCodeAt(i % key.length));
  return out;
}

const plugin = {
  popular: (n: number, f?: FilterValues) => list(catalogUrl(f, typeof f?.sort === "string" ? f.sort : "popular", n)),

  latest: (n: number) => list(catalogUrl(undefined, "recent", n)),

  search: (query: string, n: number) =>
    list(`${SITE}/search?category=works&q=${encodeURIComponent(query)}` + (n > 1 ? "&page=" + n : "")),

  async filters(): Promise<Filter[]> {
    // genres from the site's own genre index: /work/genre/<slug>
    const { doc } = await page(SITE + "/work/genre");
    const seen = new Set<string>();
    const genres: { id: string; title: string }[] = [];
    for (const a of findAll(doc.children, (e) => e.name === "a" && /^\/work\/genre\/[a-z0-9-]+$/.test(e.attribs.href || ""))) {
      const id = a.attribs.href.split("/").pop()!;
      const title = text(a);
      if (!title || seen.has(id) || id === "all") continue;
      seen.add(id); genres.push({ id, title });
    }
    genres.sort((a, b) => (a.title < b.title ? -1 : a.title > b.title ? 1 : 0));
    return [
      { id: "sort", title: "Сортировка", type: "select", default: "popular", options: SORTS },
      { id: "genre", title: "Жанр", type: "select", options: genres },
      { id: "form", title: "Форма", type: "select", options: FORMS },
    ];
  },

  async details(bookId: string): Promise<BookDetails> {
    const url = `${SITE}/work/${bookId}`;
    const { doc } = await page(url);
    const panel = find(doc.children, (e) => e.name === "div" && has(e, "book-meta-panel"));
    if (!panel) fail("CHANGED_LAYOUT", "no book card", url);
    const title = text(find(panel, (e) => e.name === "h1"));
    const genres = findAll(panel, (e) => e.name === "a" && !!e.parent && (e.parent as Element).name === "noindex").map(text).filter(Boolean);
    const tags = findAll(doc.children, (e) => e.name === "a" && /^\/work\/tag\//.test(e.attribs.href || "")).map((a) => a.attribs.title || text(a)).filter(Boolean);
    const out: BookDetails = { id: bookId, title, tags: [...genres, ...tags].filter((t, i, all) => all.findIndex((x) => x.toLowerCase() === t.toLowerCase()) === i), status: "unknown", lang: "ru", url };
    const authors = findAll(find(panel, (e) => has(e, "book-authors")) || [], (e) => e.name === "a").map(text).filter(Boolean);
    if (authors.length) out.author = authors.join(", ");
    const status = text(find(panel, (e) => e.name === "span" && has(e, "label"))).toLowerCase();
    if (status.includes("в процессе")) out.status = "ongoing";
    else if (status.includes("весь текст") || status.includes("завершен")) out.status = "completed";
    const cover = find(doc.children, (e) => e.name === "img" && has(e, "cover-image"));
    if (cover?.attribs.src) out.cover = cover.attribs.src;
    const ann = find(doc.children, (e) => e.name === "div" && has(e, "annotation"));
    const rich = ann && find(ann, (e) => e.name === "div" && has(e, "rich-content"));
    if (rich) {
      const { paras } = parseChapterHtml(DomUtils.getOuterHTML(rich), { lang: "ru", titleFromHeading: false });
      if (paras.length) out.description = paras.join("\n\n");
    }
    if (genres.some((g) => ADULT.test(g))) out.nsfw = true;
    return out;
  },

  async chapters(bookId: string): Promise<ChapterStub[]> {
    const url = `${SITE}/work/${bookId}`;
    const { doc } = await page(url);
    const toc = find(doc.children, (e) => e.name === "ul" && has(e, "table-of-content"));
    if (!toc) {
      if (!find(doc.children, (e) => has(e, "book-meta-panel"))) fail("CHANGED_LAYOUT", "no book card", url);
      // a short story: the whole text is one chapter
      const title = text(find(doc.children, (e) => e.name === "h1"));
      return [{ id: "0", title: title || "Текст", url: `${SITE}/reader/${bookId}` }];
    }
    const out: ChapterStub[] = [];
    for (const li of findAll(toc, (e) => e.name === "li")) {
      const a = find(li, (e) => e.name === "a" && new RegExp(`^/reader/${bookId}/\\d+`).test(e.attribs.href || ""));
      const time = find(li, (e) => e.name === "span" && !!e.attribs["data-time"])?.attribs["data-time"];
      const date = time && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d/.test(time) ? time.slice(0, 19) + "Z" : undefined;
      let c: ChapterStub;
      if (a) {
        const id = a.attribs.href.split("/").pop()!;
        c = { id, title: text(a), url: SITE + a.attribs.href };
      } else {
        // a paid chapter this account cannot read: no link on the site
        const title = text(find(li, (e) => e.name === "span" && !e.attribs["data-time"] && !has(e, "chapter-publish-time") && !e.attribs["data-hint"]));
        if (!title) continue;
        c = { id: "~" + title, title, url, locked: true };
      }
      if (date) c.date = date;
      out.push(c);
    }
    return out;
  },

  async chapter(bookId: string, chapterId: string) {
    if (chapterId.startsWith("~")) fail("NEEDS_LOGIN", "Глава платная: купите её на сайте и войдите", `${SITE}/work/${bookId}`);
    const readerUrl = `${SITE}/reader/${bookId}` + (chapterId === "0" ? "" : "/" + chapterId);
    const { html } = await page(readerUrl);
    const user = /userId:\s*([^,\s]+)\s*,/.exec(html)?.[1] ?? "null";
    const userId = /^\d+$/.test(user) ? user : "";
    const id = chapterId === "0" ? /chapterId:\s*(\d+)\s*,/.exec(html)?.[1] : chapterId;
    if (!id) fail("CHANGED_LAYOUT", "no chapter id", readerUrl);
    const url = `${SITE}/reader/${bookId}/chapter?id=${id}`;
    const r = await fetch(url, { headers: { ...DESKTOP, Accept: "application/json", "X-Requested-With": "XMLHttpRequest", Referer: readerUrl }, responseHeaders: ["reader-secret"] });
    if (r.status === 429) fail("RATE_LIMITED", "Author.Today 429");
    if (r.status !== 200) fail(r.status === 404 ? "NOT_FOUND" : "CHANGED_LAYOUT", `HTTP ${r.status}`, readerUrl);
    let d: any;
    try { d = JSON.parse(r.text); } catch { fail("CHANGED_LAYOUT", "not JSON", url); }
    if (!d.isSuccessful) {
      const msg = Array.isArray(d.messages) ? d.messages.join(" ") : String(d.messages || "");
      fail(userId ? "NOT_FOUND" : "NEEDS_LOGIN", msg || "chapter is not available", readerUrl);
    }
    const secret = r.headers["reader-secret"];
    if (!secret) fail("CHANGED_LAYOUT", "no Reader-Secret", url);
    const body = decrypt(String(d.data.text), secret, userId);
    // the chapter title: the reader page lists its chapters as JSON, chapters: [{"id":…,"title":…}, …]
    let title = "";
    const list = /chapters:\s*(\[[\s\S]*?\])\s*,\s*\n/.exec(html)?.[1];
    if (list) try { title = normalizeSpaces(String((JSON.parse(list) as any[]).find((c) => String(c.id) === id)?.title || "")); } catch { /* keep the fallback */ }
    if (!title) title = chapterId === "0" ? normalizeSpaces(/<title>Книга ([^,<]+)/.exec(html)?.[1] || "") || "Текст" : "Глава";
    const parsed = parseChapterHtml(body, { lang: "ru", titleFromHeading: false, fallbackTitle: title, baseUrl: SITE + "/" });
    return { kind: "text" as const, title, paras: parsed.paras, images: parsed.images };
  },

  async bookIdFromUrl(url: string): Promise<string | null> {
    const u = parseUrl(url);
    if (!u || !/(^|\.)author\.today$/.test(u.host)) return null;
    return /^\/(?:work|reader)\/(\d+)/.exec(u.pathname)?.[1] ?? null;
  },
};

definePlugin(manifest as Manifest, plugin);
