// What the PDF 문서함 shows: folder filter + name search + sort. Pure (no DOM), unit-tested.
// Originals are listed; each is followed by the files made from it (구매자 표시본 …), oldest first.

export const SORTS = [
  ["new", "최신순"],
  ["name", "이름순"],
  ["size", "큰 파일순"],
];

const norm = (s) => String(s ?? "").toLowerCase().replace(/\s+/g, " ").trim();

const COMPARE = {
  new: (a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0),
  name: (a, b) => String(a.name).localeCompare(String(b.name), "ko", { numeric: true }),
  size: (a, b) => (b.size || 0) - (a.size || 0),
};

/**
 * docs: state.docs. folder: "all" | "none" | <folder id>. query: text matched against the name of the original
 * or of any file made from it (then the original and all its copies show). sort: a key of SORTS.
 * Returns the flat, ordered list to draw.
 */
export function viewDocs(docs, { folder = "all", query = "", sort = "new" } = {}) {
  const q = norm(query);
  const kids = new Map();
  for (const d of docs) {
    if (!d.parent) continue;
    if (!kids.has(d.parent)) kids.set(d.parent, []);
    kids.get(d.parent).push(d);
  }
  const inFolder = (d) => folder === "all" || (folder === "none" ? !d.folder : d.folder === folder);
  const matches = (d) => !q || norm(d.name).includes(q) || (kids.get(d.id) ?? []).some((k) => norm(k.name).includes(q));
  const cmp = COMPARE[sort] ?? COMPARE.new;
  return docs
    .filter((d) => !d.parent && inFolder(d) && matches(d))
    .sort(cmp)
    .flatMap((d) => [d, ...(kids.get(d.id) ?? []).slice().sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0))]);
}

/** Ids 전체 선택 picks: the originals on screen (copies made from them are left out so a merge does not repeat pages). */
export const selectableIds = (view) => view.filter((d) => !d.parent).map((d) => d.id);

/** New selection after 전체 선택 / 전체 해제: all of `ids` picked -> drop them, else add the missing ones (keeps pick order). */
export function toggleAll(selected, ids) {
  if (ids.length && ids.every((id) => selected.includes(id))) return selected.filter((id) => !ids.includes(id));
  return [...selected, ...ids.filter((id) => !selected.includes(id))];
}
