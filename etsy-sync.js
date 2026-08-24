const ETSY_API_BASE = "https://api.etsy.com/v3/application";

function getEtsyConfig() {
  const keystring = process.env.ETSY_KEYSTRING;
  const sharedSecret = process.env.ETSY_SHARED_SECRET;
  const accessToken = process.env.ETSY_ACCESS_TOKEN;
  const shopId = process.env.ETSY_SHOP_ID;

  if (!keystring || !sharedSecret || !accessToken || !shopId) {
    throw new Error(
      "Missing Etsy configuration. Required: ETSY_KEYSTRING, ETSY_SHARED_SECRET, ETSY_ACCESS_TOKEN, ETSY_SHOP_ID"
    );
  }

  return {
    keystring,
    sharedSecret,
    accessToken,
    shopId,
  };
}

function buildHeaders() {
  const { keystring, sharedSecret, accessToken } = getEtsyConfig();

  return {
    "x-api-key": `${keystring}:${sharedSecret}`,
    Authorization: `Bearer ${accessToken}`,
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

export async function fetchAllActiveListings() {
  const { shopId } = getEtsyConfig();

  const limit = 100;
  let offset = 0;
  let allListings = [];

  while (true) {
    const data = await etsyRequest(
      `/shops/${shopId}/listings?state=active&limit=${limit}&offset=${offset}`
    );

    const results = Array.isArray(data.results) ? data.results : [];
    allListings.push(...results);

    if (results.length < limit || allListings.length >= Number(data.count ?? 0)) {
      break;
    }

    offset += limit;
  }

  return allListings;
}

export function convertEtsyListing(listing) {
  return {
    listing_id: String(listing.listing_id),
    title: listing.title ?? "",
    description: listing.description ?? "",
    etsy_url:
      listing.url ??
      `https://www.etsy.com/listing/${listing.listing_id}/`,
    state: listing.state ?? "",
    quantity: listing.quantity ?? null,
    price: listing.price ?? null,
    tags: Array.isArray(listing.tags) ? listing.tags : [],
    taxonomy_id: listing.taxonomy_id ?? null,
    updated_timestamp: listing.updated_timestamp ?? null,
  };
}

export async function buildEtsyCatalog() {
  const listings = await fetchAllActiveListings();

  return {
    app: "LumiKeeps Finder",
    version: "2.0",
    catalog_type: "etsy_live_catalog",
    updated_at: new Date().toISOString(),
    listing_count: listings.length,
    listings: listings.map(convertEtsyListing),
  };
}
