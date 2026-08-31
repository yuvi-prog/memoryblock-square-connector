const SQUARE_VERSION = "2025-06-18";
const BASE_URL = "https://connect.squareup.com/v2";

async function request(accessToken, method, path, body) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Square-Version": SQUARE_VERSION,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  const data = text ? JSON.parse(text) : {};

  if (!res.ok) {
    const message =
      data?.errors?.map((e) => e.detail).join("; ") || res.statusText;
    throw new Error(`Square API error (${res.status}): ${message}`);
  }
  return data;
}

// Plain GETs
export const get = (token, path) => request(token, "GET", path);

// Square's "search" endpoints are read-only but use POST with a filter body.
// Still exposed here only for read operations - never anything that mutates state.
export const searchRead = (token, path, body) =>
  request(token, "POST", path, body);

// A real write to Square. Only ever called from the price-editing tools, which are
// explicitly scoped to just price_money on an ITEM_VARIATION - never used for any
// other mutation, and never exposed as a generic passthrough.
export const write = (token, path, body) => request(token, "POST", path, body);

// Multipart upload for Square's catalog image endpoint - separate from write() because
// it can't be plain JSON. Only ever called to attach a product photo to an existing item.
export async function uploadImage(token, path, { requestBody, fileBuffer, filename, mimeType }) {
  const form = new FormData();
  form.append("request", new Blob([JSON.stringify(requestBody)], { type: "application/json" }));
  form.append("image_file", new Blob([fileBuffer], { type: mimeType }), filename);

  const res = await fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Square-Version": SQUARE_VERSION,
    },
    body: form,
  });

  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) {
    const message = data?.errors?.map((e) => e.detail).join("; ") || res.statusText;
    throw new Error(`Square API error (${res.status}): ${message}`);
  }
  return data;
}
