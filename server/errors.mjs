export class Problem extends Error {
  constructor(statusCode, message, details, code = `http_${statusCode}`) {
    super(message);
    Object.assign(this, { statusCode, details, code });
  }
}

const hidden = new Set([
  "key",
  "credential",
  "headerValues",
  "apiKey",
  "password",
  "token",
  "credentialId",
  "credentialHeadersId",
  "pendingCredentialId",
  "nativeCredentialRef",
  "headers",
  "header_override",
  "parameter_override",
  "setting",
]);

export function publicValue(value) {
  if (Array.isArray(value)) return value.map(publicValue);
  if (!value || typeof value !== "object") return value;
  const result = {};
  for (const key of Object.keys(value)) {
    const item = value[key];
    if (
      (key === "applied" && item && typeof item === "object") ||
      hidden.has(key)
    )
      continue;
    // Parsed JSON may carry an own "__proto__" key; assignment would replace the prototype instead.
    if (key === "__proto__")
      Object.defineProperty(result, key, {
        value: publicValue(item),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    else result[key] = publicValue(item);
  }
  return result;
}

export function errorMessage(error) {
  const text = Array.isArray(error?.issues)
    ? `参数不正确：${error.issues
        .map((i) => (i.path?.length ? `${i.path.join(".")}：` : "") + i.message)
        .join("；")}`
    : String(error.message || error);
  return text.replace(/\bsk-[\w-]+/g, "[凭据已隐藏]").slice(0, 400);
}
