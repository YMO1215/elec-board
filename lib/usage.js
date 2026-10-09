// How much of the free Vercel Blob storage (the photo album) is used. Framework-free so it can be unit tested.
export const BLOB_FREE_BYTES = 1024 ** 3; // Vercel Hobby (free) plan: 1 GB of Blob storage
const PAGE = 1000;
const MAX_PAGES = 50; // safety stop: 50k files

/** GET: sum the size of every photo in Blob. `list` is injected (Vercel Blob / a fake in tests). */
export async function handleUsage({ method, query = {} }, { list, key = null }) {
  if (method !== "GET") return { status: 405, json: { error: "method_not_allowed" } };
  if (key && query.key !== key) return { status: 401, json: { error: "key_required", message: "보드 링크의 키가 맞지 않습니다." } };
  if (!list) return { status: 503, json: { error: "not_configured", message: "사진 저장소가 연결되지 않았습니다." } };
  let used = 0;
  let count = 0;
  let cursor;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const res = await list({ prefix: "photos/", limit: PAGE, cursor });
    for (const blob of res.blobs ?? []) {
      used += Number(blob.size) || 0;
      count += 1;
    }
    if (!res.hasMore || !res.cursor) break;
    cursor = res.cursor;
  }
  return { status: 200, json: { used, count, limit: BLOB_FREE_BYTES } };
}
