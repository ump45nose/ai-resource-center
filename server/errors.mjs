export class Problem extends Error {
  constructor(statusCode, message, details, code = `http_${statusCode}`) {
    super(message);
    Object.assign(this, { statusCode, details, code });
  }
}

export function publicValue(value) {
  if (Array.isArray(value)) return value.map(publicValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(
        ([key, item]) =>
          !(key === "applied" && item && typeof item === "object") &&
          ![
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
          ].includes(key),
      )
      .map(([key, item]) => [key, publicValue(item)]),
  );
}

export function errorMessage(error) {
  const text = Array.isArray(error?.issues)
    ? `参数不正确：${error.issues
        .map((i) => (i.path?.length ? `${i.path.join(".")}：` : "") + i.message)
        .join("；")}`
    : String(error.message || error);
  return text.replace(/\bsk-[\w-]+/g, "[凭据已隐藏]").slice(0, 400);
}
