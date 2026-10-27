export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public details?: unknown,
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
  const data = await response.json();
  if (!response.ok) {
    if (response.status === 401)
      window.dispatchEvent(new Event("session-expired"));
    throw new ApiError(
      response.status,
      data.message || `请求未完成（${response.status}）`,
      data.details,
    );
  }
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
