export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public details?: unknown,
    public code?: string,
  ) {
    super(message);
  }
}
export async function api<T>(
  path: string,
  method = "GET",
  body?: unknown,
): Promise<T> {
  const response = await fetch(`/api/v2${path}`, {
    method,
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let data: any;
  try {
    data = text ? JSON.parse(text) : undefined;
  } catch {
    data = undefined;
  }
  if (!response.ok) {
    if (response.status === 401)
      window.dispatchEvent(new Event("session-expired"));
    throw new ApiError(
      response.status,
      (typeof data?.message === "string" && data.message) ||
        `请求未完成（${response.status}）`,
      data?.details,
      typeof data?.code === "string" ? data.code : undefined,
    );
  }
  if (text && data === undefined)
    throw new ApiError(response.status, `响应无法识别（${response.status}）`);
  return data;
}
export async function allPages<T>(path: string): Promise<T[]> {
  const rows: T[] = [];
  let cursor: string | null = "0";
  do {
    const page: { items: T[]; nextCursor: string | null } = await api(
      `${path}${path.includes("?") ? "&" : "?"}limit=200&cursor=${cursor}`,
    );
    rows.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor !== null);
  return rows;
}

export const errorText = (e: unknown, fallback = "操作未完成") =>
  e instanceof Error ? e.message : fallback;

// Other 409s are business rules whose message must stay visible.
export const isVersionConflict = (e: unknown) =>
  e instanceof ApiError &&
  e.status === 409 &&
  (e.code === "version_conflict" ||
    (typeof e.details === "object" &&
      e.details !== null &&
      "currentVersion" in e.details));
export const conflictText = "资料已在其他入口更新，已读取最新版本，请重新修改";
export async function saveError(e: unknown, reload: () => Promise<unknown>) {
  if (!isVersionConflict(e)) return errorText(e);
  try {
    await reload();
  } catch (reloadError) {
    return errorText(reloadError);
  }
  return conflictText;
}

export async function copyText(text: string) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  // The NAS is served over HTTP, where the Clipboard API is unavailable.
  const field = document.createElement("textarea");
  field.value = text;
  field.style.cssText = "position:fixed;opacity:0;pointer-events:none";
  const previous = document.activeElement;
  document.body.append(field);
  try {
    field.select();
    if (!document.execCommand("copy"))
      throw new Error("复制未完成，请保持页面在前台后重试");
  } finally {
    field.remove();
    if (previous instanceof HTMLElement)
      previous.focus({ preventScroll: true });
  }
}
