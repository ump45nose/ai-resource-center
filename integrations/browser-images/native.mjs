// Runs inside the existing, logged-in page. Login tokens never leave this scope.
export async function nativeImageTask(
  provider,
  operation,
  input,
  expectedUserId,
) {
  const origins = {
    oaichat: "https://image.oaichat.cc",
    wanzij: "https://wanzij.cc.cd",
  };
  if (!origins[provider] || location.origin !== origins[provider])
    throw new Error("页面来源不匹配");
  const token =
    provider === "oaichat"
      ? localStorage.getItem("ip_token") || sessionStorage.getItem("ip_token")
      : localStorage.getItem("chatgpt2api.adminKey");
  if (!token) throw new Error("请在原站重新登录");
  const request = async (path, body) => {
    const response = await fetch(path, {
      method: body ? "POST" : "GET",
      credentials: "same-origin",
      cache: "no-store",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(20000),
      redirect: "error",
    });
    const data = await response.json();
    if (response.status === 401 || response.status === 403)
      throw new Error("原站登录失效或需要人工验证");
    if (!response.ok)
      throw new Error(
        `原站 HTTP ${response.status}: ${String(data.detail || data.error?.message || data.message || "任务请求失败").slice(0, 300)}`,
      );
    return data;
  };
  const status = await request(
    provider === "oaichat" ? "/api/status" : "/auth/status",
  );
  const userId = String(
    provider === "oaichat" ? status.user_id : status.subject?.id,
  );
  if (userId !== expectedUserId)
    throw new Error("当前登录账号与渠道绑定不一致");
  if (provider === "wanzij" && !status.capabilities?.studio)
    throw new Error("当前账号没有工作台权限");
  if (operation === "inspect")
    return provider === "oaichat"
      ? {
          userId,
          models: status.available_models,
          dailyRemaining: status.user_daily_quota_available,
          permanentRemaining: status.user_permanent_quota_available,
          checked: status.user_daily_checkin_completed,
        }
      : { userId, studio: true };

  if (operation === "create") {
    let data;
    if (provider === "oaichat") {
      if (!status.available_models?.includes(input.model))
        throw new Error("模型不在原站当前目录中");
      if (status.maintenance_enabled) throw new Error("原站正在维护");
      if (status.user_effective_quota_available <= 0)
        throw new Error("原站生图额度已耗尽");
      const grant = JSON.parse(
        localStorage.getItem("ip_image_captcha_grant") || "null",
      );
      const grantToken =
        grant?.expiresAt > Date.now() / 1000 + 3 ? grant.token : "";
      if (status.turnstile_enabled && !grantToken)
        throw new Error("原站需要人机验证，请在工作台完成验证后重试");
      // One mutation only. A transport failure must never replay this request.
      data = await request("/api/tasks", {
        prompt: input.prompt,
        mode: "generate",
        model: input.model,
        aspect_ratio: input.aspectRatio,
        share_to_gallery: false,
        cf_turnstile_token: "",
        image_captcha_grant_token: grantToken,
      });
      if (data.image_captcha_grant_token && data.image_captcha_grant_expires_at)
        localStorage.setItem(
          "ip_image_captcha_grant",
          JSON.stringify({
            token: data.image_captcha_grant_token,
            expiresAt: data.image_captcha_grant_expires_at,
          }),
        );
    } else {
      data = await request("/api/image-tasks/generations", {
        client_task_id: `gen-${input.id}`,
        prompt: input.prompt,
        model: input.model,
        n: 1,
        quality: input.quality || "auto",
        ...(input.nativeSize ? { size: input.nativeSize } : {}),
      });
    }
    const id = data.id || data.task_id || data.task?.id;
    if (!id)
      throw new Error("提交结果缺少任务标识，请先在原站核对，勿重复提交");
    return { id: String(id) };
  }
  if (operation === "poll") {
    // These are the same list endpoints used by both native workbenches.
    const data = await request(
      provider === "oaichat"
        ? "/api/tasks/mine?page=1&page_size=50"
        : `/api/image-tasks?ids=${encodeURIComponent(input.remoteId)}`,
    );
    const task = (data.tasks || data.items || []).find(
      (t) => String(t.id) === input.remoteId,
    );
    if (!task) throw new Error("原站未返回该任务，请保留任务标识核对");
    const succeeded =
      provider === "oaichat"
        ? task.status === "succeeded"
        : task.status === "success";
    const failed =
      provider === "oaichat"
        ? task.status === "failed"
        : task.terminal && !succeeded;
    const images =
      provider === "oaichat"
        ? task.image_url
          ? [{ url: task.image_url }]
          : []
        : (task.results || []).map((r) => ({
            ...(r.url ? { url: r.url } : {}),
            ...(r.b64_json ? { b64_json: r.b64_json } : {}),
          }));
    return {
      status: succeeded ? "succeeded" : failed ? "failed" : "running",
      images,
      error: failed
        ? String(
            task.public_error ||
              task.error_message ||
              task.error ||
              "原站生成失败",
          ).slice(0, 300)
        : null,
    };
  }
  if (operation === "image") {
    const url = new URL(input.url, location.origin);
    const response = await fetch(url, {
      credentials: url.origin === location.origin ? "same-origin" : "omit",
      signal: AbortSignal.timeout(20000),
    });
    if (
      !response.ok ||
      !response.headers.get("Content-Type")?.startsWith("image/")
    )
      throw new Error("无法读取原站生成图片");
    const blob = await response.blob();
    if (blob.size > 20 * 1024 * 1024) throw new Error("图片超过 20MB");
    return await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = reject;
      reader.onload = () => resolve({ b64_json: reader.result.split(",")[1] });
      reader.readAsDataURL(blob);
    });
  }
  throw new Error("不支持的任务操作");
}

export function nativeInput(provider, body, id) {
  const supported = [
    "model",
    "prompt",
    "n",
    "size",
    "quality",
    "response_format",
    "user",
  ];
  const unknown = Object.keys(body).filter((key) => !supported.includes(key));
  if (unknown.length)
    throw new Error(`暂不支持的生图参数：${unknown.join("、")}`);
  if (body.n !== undefined && body.n !== 1)
    throw new Error("每次只支持生成一张图片");
  if (
    typeof body.prompt !== "string" ||
    !body.prompt.trim() ||
    body.prompt.length > 16000
  )
    throw new Error("请输入 1～16000 字符的提示词");
  if (![undefined, "url", "b64_json"].includes(body.response_format))
    throw new Error("不支持的图片返回格式");
  const size = body.size || "auto";
  const sizes = {
    auto: "auto",
    "1024x1024": "1:1",
    "1024x1536": "2:3",
    "1536x1024": "3:2",
    "1024x1365": "3:4",
    "1365x1024": "4:3",
    "1088x1920": "9:16",
    "1920x1088": "16:9",
  };
  if (!sizes[size]) throw new Error("不支持的图片尺寸");
  if (![undefined, "auto", "low", "medium", "high"].includes(body.quality))
    throw new Error("不支持的图片质量");
  if (provider === "oaichat" && body.quality && body.quality !== "auto")
    throw new Error("Image Playground 不支持指定图片质量");
  return {
    id,
    prompt: body.prompt,
    model: body.model,
    aspectRatio: sizes[size],
    nativeSize:
      provider === "wanzij" && body.model.startsWith("grok-")
        ? `grok:1k:${sizes[size] === "auto" ? "1:1" : sizes[size]}`
        : size === "auto"
          ? undefined
          : size,
    quality: body.quality || "auto",
    responseFormat: body.response_format || "url",
  };
}
