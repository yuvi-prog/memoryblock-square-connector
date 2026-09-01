// Monday.com -> Square catalog sync. Runs in DRY_RUN mode unless SYNC_MODE=live -
// in dry run it computes and logs exactly what it WOULD do to every company's Square
// catalog, but never actually calls a write endpoint. Flip SYNC_MODE=live when ready.
import { listCompanyNames, getCompany } from "./companies.js";
import { findItemByExactName, createItem, attachItemImage } from "./catalogItems.js";
import { get, write } from "./square.js";
import { locationsById } from "./reports.js";

const MONDAY_API = "https://api.monday.com/v2";
const BOARD_ID = "5030789525";

// Column ids on the "Products" board (see get_board_info) - kept as one map so a
// board redesign only means editing this block.
const COLUMNS = {
  sku: "text_mm6f1482",
  productType: "color_mm6fj50m", // e.g. Pine, Bamboo, Acrylic, Beechwood
  shape: "color_mm6fgj9g", // e.g. Square, Rectangle, Hexagon, Heart
  size: "color_mm6fat5h", // e.g. XS, S, M, L, XL, G
  rrp: "numeric_mm6fx0r9",
  squareToggle: "boolean_mm6fa9h8",
};
export const IMAGE_COLUMN_ID = "file_mm6sxszf"; // "Product Images" file column

export const SYNC_MODE = process.env.SYNC_MODE === "live" ? "live" : "dry_run";

async function mondayApi(query, variables) {
  const token = process.env.MONDAY_API_TOKEN;
  if (!token) throw new Error("MONDAY_API_TOKEN is not configured - cannot fetch board data.");
  const res = await fetch(MONDAY_API, {
    method: "POST",
    headers: { Authorization: token, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  const data = await res.json();
  if (data.errors) throw new Error(`Monday API error: ${JSON.stringify(data.errors)}`);
  return data.data;
}

async function fetchRow(itemId) {
  const query = `query ($itemId: [ID!]) {
    items(ids: $itemId) {
      id
      column_values(ids: ${JSON.stringify(Object.values(COLUMNS))}) { id text }
    }
  }`;
  const data = await mondayApi(query, { itemId: [itemId] });
  const item = data.items?.[0];
  if (!item) throw new Error(`Monday item ${itemId} not found`);
  const byId = Object.fromEntries(item.column_values.map((c) => [c.id, c.text]));
  return {
    sku: byId[COLUMNS.sku],
    productType: byId[COLUMNS.productType],
    shape: byId[COLUMNS.shape],
    size: byId[COLUMNS.size],
    rrp: byId[COLUMNS.rrp] ? Number(byId[COLUMNS.rrp]) : null,
    squareTicked: byId[COLUMNS.squareToggle] === "v",
  };
}

function deriveItemName(row) {
  if (!row.shape || !row.productType) return null;
  return `${row.shape} ${row.productType}`;
}

// Looks up whatever's attached to a row's file column and resolves it to a
// downloadable Monday asset (public_url is a short-lived signed URL - fine, since
// this is only ever used immediately, not stored).
async function fetchRowImage(itemId) {
  const query = `query ($itemId: [ID!]) {
    items(ids: $itemId) {
      column_values(ids: ["${IMAGE_COLUMN_ID}"]) {
        ... on FileValue { files { ... on FileAssetValue { asset_id } } }
      }
    }
  }`;
  const data = await mondayApi(query, { itemId: [itemId] });
  const assetId = data.items?.[0]?.column_values?.[0]?.files?.[0]?.asset_id;
  if (!assetId) return null;

  const assetQuery = `query ($assetIds: [ID!]) { assets(ids: $assetIds) { public_url name file_extension } }`;
  const assetData = await mondayApi(assetQuery, { assetIds: [assetId] });
  const asset = assetData.assets?.[0];
  if (!asset?.public_url) return null;

  const ext = (asset.file_extension || "png").toLowerCase().replace(".", "");
  const mimeType = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", gif: "image/gif" }[ext] || "image/png";
  return { publicUrl: asset.public_url, filename: asset.name || `image.${ext}`, mimeType };
}

async function downloadImage(publicUrl) {
  const res = await fetch(publicUrl);
  if (!res.ok) throw new Error(`Failed to download image from Monday (${res.status})`);
  return Buffer.from(await res.arrayBuffer());
}

// Downloads a row's image ONCE (not once per company) and returns a ready-to-attach
// buffer, or null if the row has no image attached.
async function loadRowImage(itemId) {
  const meta = await fetchRowImage(itemId);
  if (!meta) return null;
  const fileBuffer = await downloadImage(meta.publicUrl);
  return { fileBuffer, filename: meta.filename, mimeType: meta.mimeType };
}

// Attaches an already-downloaded image to the Square item for one company - skips
// if that item already has an image, so re-running the sync never re-uploads.
async function attachImageToCompany(token, itemName, image) {
  if (!image) return null;
  return attachItemImage(token, {
    itemName,
    fileBuffer: image.fileBuffer,
    filename: image.filename,
    mimeType: image.mimeType,
    skipIfImageExists: true,
  });
}

async function fetchAllRows() {
  const rows = [];
  let cursor = null;
  do {
    const query = cursor
      ? `query ($cursor: String!) {
          next_items_page(cursor: $cursor, limit: 100) {
            cursor
            items { id column_values(ids: ${JSON.stringify(Object.values(COLUMNS))}) { id text } }
          }
        }`
      : `query ($boardId: [ID!]) {
          boards(ids: $boardId) {
            items_page(limit: 100) {
              cursor
              items { id column_values(ids: ${JSON.stringify(Object.values(COLUMNS))}) { id text } }
            }
          }
        }`;
    const variables = cursor ? { cursor } : { boardId: [BOARD_ID] };
    const data = await mondayApi(query, variables);
    const page = cursor ? data.next_items_page : data.boards[0].items_page;
    for (const item of page.items) {
      const byId = Object.fromEntries(item.column_values.map((c) => [c.id, c.text]));
      rows.push({
        itemId: item.id,
        sku: byId[COLUMNS.sku],
        productType: byId[COLUMNS.productType],
        shape: byId[COLUMNS.shape],
        size: byId[COLUMNS.size],
        rrp: byId[COLUMNS.rrp] ? Number(byId[COLUMNS.rrp]) : null,
        squareTicked: byId[COLUMNS.squareToggle] === "v",
      });
    }
    cursor = page.cursor;
  } while (cursor);
  return rows;
}

// Fetches a company's whole catalog ONCE and indexes it, so a full-board reconcile
// doesn't re-fetch the catalog for every row (would be rows x companies calls otherwise).
async function fetchCatalogMap(token) {
  const map = {};
  let cursor;
  do {
    const page = await get(token, `/catalog/list?types=ITEM${cursor ? `&cursor=${cursor}` : ""}`);
    for (const item of page.objects || []) {
      if (item.type !== "ITEM") continue;
      map[item.item_data.name.toLowerCase()] = item;
    }
    cursor = page.cursor;
  } while (cursor);
  return map;
}

function findVariationIn(item, variationName) {
  return item?.item_data?.variations?.find(
    (v) => v.item_variation_data?.name?.toLowerCase() === variationName.toLowerCase()
  );
}

// Runs the same create/hide decision as syncRow but against a pre-fetched catalog
// map instead of hitting the network per row - used by RECONCILE_all_products.
export async function reconcileAll() {
  const rows = (await fetchAllRows()).filter((r) => {
    const itemName = deriveItemName(r);
    return itemName && r.size && r.sku;
  });

  const summary = {
    itemsProcessed: rows.length,
    wouldCreate: 0,
    wouldHide: 0,
    alreadyCorrect: 0,
    imagesAttached: 0,
    imagesWouldAttach: 0,
    errors: 0,
    actions: [],
  };

  // Metadata is cheap and fetched (and cached per item name) regardless of mode, so
  // dry_run can preview it; actual bytes are only downloaded right before a live upload.
  const imageMetaCache = new Map();
  async function getImageMetaForRow(row) {
    const itemName = deriveItemName(row);
    if (!row.squareTicked || !itemName) return null;
    if (imageMetaCache.has(itemName)) return imageMetaCache.get(itemName);
    let meta = null;
    try {
      meta = await fetchRowImage(row.itemId);
    } catch (err) {
      console.error(`[monday-sync] fetchRowImage failed for item ${row.itemId}:`, err.message);
    }
    imageMetaCache.set(itemName, meta);
    return meta;
  }

  for (const name of listCompanyNames()) {
    const c = getCompany(name);
    let catalogMap;
    try {
      catalogMap = await fetchCatalogMap(c.accessToken);
    } catch (err) {
      summary.errors += 1;
      summary.actions.push({ company: name, error: `Could not read catalog: ${err.message}` });
      continue;
    }

    let activeLocationIds, currency;

    for (const row of rows) {
      const itemName = deriveItemName(row);
      const existingItem = catalogMap[itemName.toLowerCase()];
      const existingVariation = findVariationIn(existingItem, row.size);

      if (row.squareTicked) {
        if (!existingVariation) {
          summary.wouldCreate += 1;
          summary.actions.push({
            company: name,
            itemName,
            variationName: row.size,
            action: existingItem ? "add variation to existing item" : "create new item + variation",
          });
          if (SYNC_MODE === "live") {
            try {
              if (existingItem) {
                await addVariationToItem(c.accessToken, existingItem, { name: row.size, sku: row.sku, price: row.rrp });
              } else {
                if (!activeLocationIds) {
                  const locsById = await locationsById(c.accessToken);
                  activeLocationIds = Object.entries(locsById).filter(([, l]) => l.status === "ACTIVE").map(([id]) => id);
                  currency = Object.values(locsById)[0]?.currency || "AUD";
                }
                const created = await createItem(c.accessToken, {
                  itemName,
                  variations: [{ name: row.size, sku: row.sku, price: row.rrp }],
                  locationIds: activeLocationIds,
                  currency,
                });
                // Keep the in-memory map current so a second row for the same new item
                // (e.g. another size) adds a variation instead of creating a duplicate item.
                catalogMap[itemName.toLowerCase()] = { id: created.catalogObjectId, item_data: { name: itemName, variations: [], image_ids: [] } };
              }
            } catch (err) {
              summary.errors += 1;
              summary.actions.push({ company: name, itemName, variationName: row.size, error: err.message });
            }
          }
        } else {
          summary.alreadyCorrect += 1;
        }

        // Consider the image regardless of whether the variation (or item) was just
        // created or already existed - covers items that predate this image feature.
        const imageMeta = await getImageMetaForRow(row);
        if (imageMeta) {
          const hasImage = catalogMap[itemName.toLowerCase()]?.item_data?.image_ids?.length > 0;
          if (!hasImage) {
            if (SYNC_MODE === "live") {
              try {
                const image = await loadRowImage(row.itemId);
                const result = await attachImageToCompany(c.accessToken, itemName, image);
                if (result && !result.skipped) {
                  summary.imagesAttached += 1;
                  // Reflect it in the cached map so a sibling size row for the same item
                  // (checked later in this same pass) doesn't try to attach it again.
                  const cached = catalogMap[itemName.toLowerCase()];
                  if (cached) cached.item_data.image_ids = [result.imageCatalogObjectId];
                }
              } catch (err) {
                summary.errors += 1;
                summary.actions.push({ company: name, itemName, warning: `Image attach failed: ${err.message}` });
              }
            } else {
              summary.imagesWouldAttach += 1;
              summary.actions.push({ company: name, itemName, action: `would attach image (${imageMeta.filename})` });
            }
          }
        }
      } else {
        if (!existingVariation) {
          summary.alreadyCorrect += 1;
          continue;
        }
        summary.wouldHide += 1;
        summary.actions.push({ company: name, itemName, variationName: row.size, action: "hide variation (remove from all locations)" });
        if (SYNC_MODE === "live") {
          try {
            await hideVariation(c.accessToken, existingVariation);
          } catch (err) {
            summary.errors += 1;
            summary.actions.push({ company: name, itemName, variationName: row.size, error: err.message });
          }
        }
      }
    }
  }

  return { mode: SYNC_MODE, ...summary };
}

// The core sync decision for one row. Always safe to call - only WRITES if
// SYNC_MODE is "live"; otherwise returns the plan without touching Square.
export async function syncRow(itemId) {
  const row = await fetchRow(itemId);
  const itemName = deriveItemName(row);
  if (!itemName || !row.size || !row.sku) {
    return { itemId, skipped: true, reason: "Row is missing Shape, Product Type, Size, or SKU - can't map to a Square item." };
  }

  const plan = {
    itemId,
    action: row.squareTicked ? "create-if-missing" : "hide-if-present",
    itemName,
    variationName: row.size,
    sku: row.sku,
    price: row.rrp,
    perCompany: [],
  };

  // Metadata is cheap (one Monday API call) and fetched even in dry_run, so the
  // preview can report "would attach image" - the actual bytes are only downloaded
  // right before an upload, in live mode.
  let imageMeta = null;
  if (row.squareTicked) {
    try {
      imageMeta = await fetchRowImage(itemId);
    } catch (err) {
      console.error(`[monday-sync] fetchRowImage failed for item ${itemId}:`, err.message);
    }
  }

  for (const name of listCompanyNames()) {
    const c = getCompany(name);
    try {
      const existingItem = await findItemByExactName(c.accessToken, itemName);
      const existingVariation = existingItem?.item_data?.variations?.find(
        (v) => v.item_variation_data?.name?.toLowerCase() === row.size.toLowerCase()
      );

      if (row.squareTicked) {
        if (existingVariation) {
          plan.perCompany.push({ company: name, wouldDo: "nothing - variation already exists", catalogObjectId: existingVariation.id });
        } else {
          plan.perCompany.push({
            company: name,
            wouldDo: existingItem ? "add variation to existing item" : "create new item + variation",
          });
          if (SYNC_MODE === "live") {
            // Only ever CREATEs (item or variation) - never overwrites an existing variation's price.
            if (existingItem) {
              await addVariationToItem(c.accessToken, existingItem, { name: row.size, sku: row.sku, price: row.rrp });
            } else {
              const locsById = await locationsById(c.accessToken);
              const activeIds = Object.entries(locsById).filter(([, l]) => l.status === "ACTIVE").map(([id]) => id);
              const currency = Object.values(locsById)[0]?.currency || "AUD";
              await createItem(c.accessToken, {
                itemName,
                variations: [{ name: row.size, sku: row.sku, price: row.rrp }],
                locationIds: activeIds,
                currency,
              });
            }
          }
        }
        if (imageMeta) {
          const hasImage = existingItem?.item_data?.image_ids?.length > 0;
          if (hasImage) {
            plan.perCompany.push({ company: name, image: "nothing - item already has an image" });
          } else if (SYNC_MODE === "live") {
            try {
              const image = await loadRowImage(itemId);
              await attachImageToCompany(c.accessToken, itemName, image);
              plan.perCompany.push({ company: name, image: `attached ${imageMeta.filename}` });
            } catch (err) {
              plan.perCompany.push({ company: name, image: `FAILED: ${err.message}` });
            }
          } else {
            plan.perCompany.push({ company: name, image: `would attach ${imageMeta.filename}` });
          }
        }
      } else {
        if (!existingVariation) {
          plan.perCompany.push({ company: name, wouldDo: "nothing - variation doesn't exist here" });
          continue;
        }
        plan.perCompany.push({ company: name, wouldDo: "hide variation (remove from all locations)", catalogObjectId: existingVariation.id });
        if (SYNC_MODE === "live") {
          await hideVariation(c.accessToken, existingVariation);
        }
      }
    } catch (err) {
      plan.perCompany.push({ company: name, error: err.message });
    }
  }

  return plan;
}

async function addVariationToItem(token, existingItem, { name, sku, price }) {
  const currency = existingItem.item_data.variations[0]?.item_variation_data?.price_money?.currency || "AUD";
  const updated = {
    ...existingItem,
    item_data: {
      ...existingItem.item_data,
      variations: [
        ...existingItem.item_data.variations,
        {
          type: "ITEM_VARIATION",
          id: "#new_variation",
          item_variation_data: {
            item_id: existingItem.id,
            name,
            sku,
            pricing_type: "FIXED_PRICING",
            price_money: { amount: Math.round((price || 0) * 100), currency },
          },
        },
      ],
    },
  };
  return write(token, "/catalog/object", { idempotency_key: `add-variation-${existingItem.id}-${name}-${Date.now()}`, object: updated });
}

async function hideVariation(token, variation) {
  const updated = {
    ...variation,
    item_variation_data: {
      ...variation.item_variation_data,
      present_at_all_locations: false,
      present_at_location_ids: [],
    },
  };
  return write(token, "/catalog/object", { idempotency_key: `hide-${variation.id}-${Date.now()}`, object: updated });
}
