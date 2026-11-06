export const newApiType = (protocol) =>
  protocol === "Anthropic" ? 14 : protocol === "Gemini" ? 24 : 1;
const typeProtocol = (type) =>
  type === 14 ? "Anthropic" : type === 24 ? "Gemini" : "OpenAI";
// An existing channel keeps a compatible native type, such as an OpenAI-compatible vendor type.
export const channelType = (protocol, remote) =>
  remote &&
  typeProtocol(remote.type) ===
    (protocol === "OpenAI Responses" ? "OpenAI" : protocol)
    ? remote.type
    : newApiType(protocol);
export const headerOverride = (headers) =>
  JSON.stringify(Object.fromEntries(headers.map((h) => [h.name, h.value])));
export const passthroughSetting = (c) =>
  c.nativePassthrough
    ? { setting: JSON.stringify({ pass_through_body_enabled: true }) }
    : {};
export const findByTag = async (sources, source, tag) =>
  (await sources.pages(source, "/api/channel/")).find((r) => r.tag === tag);
