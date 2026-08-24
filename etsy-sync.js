const ETSY_API_BASE = "https://api.etsy.com/v3/application";

function getEtsyConfig() {
  const keystring = process.env.ETSY_KEYSTRING;
  const sharedSecret = process.env.ETSY_SHARED_SECRET;
  const shopId = process.env.ETSY_SHOP_ID || "";
  const shopName = process.env.ETSY_SHOP_NAME || "LumiKeeps";

  if (!keystring || !sharedSecret) {
    throw new Error(
      "Missing Etsy configuration: ETSY_KEYSTRING and ETSY_SHARED_SECRET"
    );
  }

  return {
    keystring,
    sharedSecret,
    shopId,
    shopName,
  };
}

function buildHeaders() {
  const { keystring, sharedSecret } = getEtsyConfig();

  return {
    "x-api-key": `${keystring}:${sharedSecret}`,
    Accept: "application/json",
  };
}

async function etsyRequest(path) {
  const response = await fetch(`${ETSY_API_BASE}${path}`, {
    method: "GET",
    headers: buildHeaders(),
  });

  if (!response.ok) {
    const body = await response.text();

    throw new Error(
      `Etsy API error ${response.status}: ${body || response.statusText}`
    );
  }

  return response.json();
}

async function resolveShopId() {
  const { shopId, shopName } = getEtsyConfig();

  if (shopId) {
    return String(shopId);
  }

  const data = await etsyRequest(
    `/shops?shop_name=${encodeURIComponent(shopName)}&limit=100`
  );

  const shops = Array.isArray(data.results) ? data.results : [];

  const exactMatch = shops.find(
    (shop) =>
      String(shop.shop_name || "").toLowerCase() ===
      String(shopName).toLowerCase()
  );

  const selectedShop = exactMatch || shops[0];

  if (!selectedShop?.shop_id) {
    throw new Error(`Etsy shop "${shopName}" not found.`);
  }

  return String(selectedShop.shop_id);
}

async function fetchActiveListings(shopId) {
  const limit = 100;
  let offset = 0;
  const allListings = [];

  while (true) {
    const data = await etsyRequest(
      `/shops/${shopId}/listings/active?limit=${limit}&offset=${offset}`
    );

    const results = Array.isArray(data.results) ? data.results : [];

    allListings.push(...results);

    const total = Number(data.count ?? allListings.length);

    if (results.length === 0 || allListings.length >= total) {
      break;
    }

    offset += limit;
  }

  return allListings;
}

async function enrichListingsWithImages(listings) {
  if (!listings.length) {
    return listings;
  }

  const enriched = [];

  for (let index = 0; index < listings.length; index += 100) {
    const chunk = listings.slice(index, index + 100);

    const ids = chunk
      .map((listing) => listing.listing_id)
      .filter(Boolean)
      .join(",");

    try {
      const data = await etsyRequest(
        `/listings/batch?listing_ids=${encodeURIComponent(ids)}&includes=Images`
      );

      const results = Array.isArray(data.results) ? data.results : [];
      const byId = new Map(
        results.map((listing) => [String(listing.listing_id), listing])
      );

      enriched.push(
        ...chunk.map(
          (listing) => byId.get(String(listing.listing_id)) ?? listing
        )
      );
    } catch (error) {
      console.warn(
        "Etsy image enrichment failed for a listing batch; keeping listing data without images:",
        error instanceof Error ? error.message : String(error)
      );
      enriched.push(...chunk);
    }
  }

  return enriched;
}

function getPrimaryImage(listing) {
  const images = Array.isArray(listing.images) ? listing.images : [];

  if (!images.length) {
    return null;
  }

  const sorted = [...images].sort(
    (a, b) => Number(a.rank ?? 999) - Number(b.rank ?? 999)
  );

  return (
    sorted[0]?.url_fullxfull ||
    sorted[0]?.url_570xN ||
    sorted[0]?.url_170x135 ||
    null
  );
}

function convertEtsyListing(listing) {
  const images = Array.isArray(listing.images)
    ? listing.images.map((image) => ({
        rank: image.rank ?? null,
        url_170x135: image.url_170x135 ?? null,
        url_570xN: image.url_570xN ?? null,
        url_fullxfull: image.url_fullxfull ?? null,
        alt_text: image.alt_text ?? "",
      }))
    : [];

  return {
    listing_id: String(listing.listing_id),
    title: listing.title ?? "",
    description: listing.description ?? "",
    etsy_url:
      listing.url ??
      `https://www.etsy.com/listing/${listing.listing_id}/`,
    state: listing.state ?? "active",
    quantity: listing.quantity ?? null,
    price: listing.price ?? null,
    tags: Array.isArray(listing.tags) ? listing.tags : [],
    taxonomy_id: listing.taxonomy_id ?? null,
    is_personalizable: Boolean(listing.is_personalizable),
    updated_timestamp:
      listing.updated_timestamp ??
      listing.last_modified_timestamp ??
      null,
    primary_image: getPrimaryImage(listing),
    images,
  };
}

export async function buildEtsyCatalog() {
  const shopId = await resolveShopId();

  const activeListings = await fetchActiveListings(shopId);

  const listingsWithImages =
    await enrichListingsWithImages(activeListings);

  return {
    app: "LumiKeeps Finder",
    version: "2.0",
    catalog_type: "etsy_live_catalog",
    shop_id: shopId,
    updated_at: new Date().toISOString(),
    listing_count: listingsWithImages.length,
    listings: listingsWithImages.map(convertEtsyListing),
  };
} 
