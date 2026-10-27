export class Problem extends Error {
  constructor(statusCode, message, details, code = `http_${statusCode}`) {
    super(message);
    Object.assign(this, { statusCode, details, code });
  }
}

export function requireValue(value, message = "对象不存在") {
  if (!value) throw new Problem(404, message);
  return value;
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
  return String(error.message || error)
    .replace(/\bsk-[\w-]+/g, "[凭据已隐藏]")
    .slice(0, 400);
}
