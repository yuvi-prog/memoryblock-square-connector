// Price-editing support. Deliberately narrow: the only mutation this file can ever
// produce is overwriting price_money on one existing ITEM_VARIATION. It never creates,
// deletes, or renames anything, and never touches any other object type.
import { get, write } from "./square.js";

export async function findVariations(token, { itemName, variationName }) {
  const matches = [];
  let cursor;
  do {
    const page = await get(token, `/catalog/list?types=ITEM${cursor ? `&cursor=${cursor}` : ""}`);
    for (const item of page.objects || []) {
      if (item.type !== "ITEM") continue;
      if (itemName && !item.item_data?.name?.toLowerCase().includes(itemName.toLowerCase())) continue;
      for (const v of item.item_data?.variations || []) {
        const vName = v.item_variation_data?.name || "";
        if (variationName && !vName.toLowerCase().includes(variationName.toLowerCase())) continue;
        matches.push({
          catalogObjectId: v.id,
          itemName: item.item_data.name,
          variationName: vName,
          currentPrice: v.item_variation_data?.price_money?.amount,
          currency: v.item_variation_data?.price_money?.currency,
          version: v.version,
        });
      }
    }
    cursor = page.cursor;
  } while (cursor);
  return matches;
}

export async function fetchVariation(token, catalogObjectId) {
  const res = await get(token, `/catalog/object/${encodeURIComponent(catalogObjectId)}`);
  const obj = res.object;
  if (!obj || obj.type !== "ITEM_VARIATION") {
    throw new Error(`${catalogObjectId} is not an ITEM_VARIATION catalog object`);
  }
  return obj;
}

// Applies a price change. Requires the caller to state the price they believe is
// currently live (from a prior preview) - if the live price has since moved, this
// refuses rather than silently overwriting someone else's more recent change.
export async function applyPriceChange(token, { catalogObjectId, expectedCurrentPriceCents, newPriceCents }) {
  const obj = await fetchVariation(token, catalogObjectId);
  const liveAmount = obj.item_variation_data?.price_money?.amount;
  const currency = obj.item_variation_data?.price_money?.currency || "AUD";

  if (liveAmount !== expectedCurrentPriceCents) {
    throw new Error(
      `Refusing to apply: live price is ${(liveAmount ?? 0) / 100} ${currency}, but expectedCurrentPrice was ${expectedCurrentPriceCents / 100}. Re-run the preview to see the current state before retrying.`
    );
  }

  // Only price_money is touched - every other field on the variation is round-tripped as-is.
  const updatedVariation = {
    ...obj,
    item_variation_data: {
      ...obj.item_variation_data,
      price_money: { amount: newPriceCents, currency },
    },
  };

  const result = await write(token, "/catalog/object", {
    idempotency_key: `price-update-${catalogObjectId}-${Date.now()}`,
    object: updatedVariation,
  });

  return {
    catalogObjectId,
    previousPrice: liveAmount / 100,
    newPrice: newPriceCents / 100,
    currency,
    newVersion: result.catalog_object?.version,
  };
}
