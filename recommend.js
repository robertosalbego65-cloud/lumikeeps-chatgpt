function normalize(text = "") {
  return String(text)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const expansions = [
  [/\b(nonni|nonno|nonna|nipoti|nipote|grandparents|grandmother|grandfather)\b/, "family grandparents"],
  [/\b(famiglia|figli|figlio|figlia|mamma|madre|papa|padre|family|parents)\b/, "family parents children"],
  [/\b(coppia|fidanzato|fidanzata|marito|moglie|partner|couple|husband|wife)\b/, "couple anniversary"],
  [/\b(matrimonio|sposi|sposa|sposo|nozze|wedding|engagement)\b/, "wedding couple engagement"],
  [/\b(anniversario|san valentino|valentino|anniversary|valentine)\b/, "anniversary valentine couple"],
  [/\b(amico|amica|amici|amiche|bff|friend|friends|friendship|bestie)\b/, "best friends friendship bff"],
  [/\b(lontano|lontana|distanza|estero|long distance|abroad)\b/, "long distance friends abroad"],
  [/\b(cane|cagnolino|gatto|gattino|animale|animali|pet|dog|cat)\b/, "pet dog cat"],
  [/\b(morto|morta|scomparso|scomparsa|mancato|mancata|ricordo|memoriale|memorial|remembrance)\b/, "memorial remembrance"],
  [/\b(natale|natalizio|natalizia|christmas|holiday)\b/, "christmas holiday"],
  [/\b(halloween)\b/, "halloween spooky"],
  [/\b(moto|motocicletta|motociclista|biker|motorcycle)\b/, "motorcycle biker"],
  [/\b(auto|macchina|automobile|car)\b/, "car automotive"],
  [/\b(foto separate|fotografie separate|foto diverse|unire foto|separate photos|combine photos)\b/, "separate photos combine photos"],
  [/\b(prima e adesso|ieri e oggi|then and now)\b/, "then and now memories"]
];

function expandQuery(query) {
  const base = normalize(query);
  const additions = expansions.filter(([re]) => re.test(base)).map(([, value]) => value);
  return normalize([base, ...additions].join(" "));
}

function searchableText(item) {
  return normalize([
    item.concept,
    item.category,
    item.people,
    item.summary,
    ...(item.keywords ?? []),
    ...(item.occasion ?? []),
    item.memorial ? "memorial remembrance" : "",
    item.separate_photos ? "separate photos combine photos" : "",
    item.pets_allowed ? "pet dog cat" : ""
  ].join(" "));
}

function scoreItem(request, item) {
  const expanded = expandQuery(request);
  const haystack = searchableText(item);
  const words = [...new Set(expanded.split(" ").filter((word) => word.length >= 3))];
  let score = 0;
  for (const word of words) if (haystack.includes(word)) score += 2;

  const q = normalize(request);
  if (/\b(morto|morta|scomparso|scomparsa|memoriale|memorial|ricordo|remembrance)\b/.test(q)) score += item.memorial ? 20 : -8;
  if (/\b(cane|gatto|animale|pet|dog|cat)\b/.test(q)) score += item.pets_allowed ? 10 : -5;
  if (/\b(famiglia|nonni|nipoti|figli|mamma|papa|family|parents|grandparents)\b/.test(q)) score += item.people === "family" ? 10 : 0;
  if (/\b(coppia|fidanzato|fidanzata|marito|moglie|couple|husband|wife)\b/.test(q)) score += item.people === "couple" ? 10 : 0;
  if (/\b(amico|amica|amici|amiche|bff|friend|friends|bestie)\b/.test(q)) score += item.people === "friends" ? 10 : 0;
  if (/\b(foto separate|fotografie separate|foto diverse|unire foto|separate photos|combine photos)\b/.test(q)) score += item.separate_photos ? 12 : -4;
  if (/\b(natale|natalizio|natalizia|christmas)\b/.test(q)) score += haystack.includes("christmas") ? 14 : 0;
  if (/\bhalloween\b/.test(q)) score += haystack.includes("halloween") ? 14 : 0;
  if (/\b(moto|motocicletta|motociclista|biker|motorcycle)\b/.test(q)) score += haystack.includes("motorcycle") ? 16 : 0;
  if (/\b(auto|macchina|automobile|car)\b/.test(q)) score += haystack.includes("car") || haystack.includes("automotive") ? 16 : 0;
  if (/\b(lontano|lontana|distanza|estero|long distance|abroad)\b/.test(q)) score += haystack.includes("long distance") ? 16 : 0;
  if (/\b(matrimonio|sposi|sposa|sposo|nozze|wedding)\b/.test(q)) score += haystack.includes("wedding") ? 16 : 0;
  return score;
}

function photoGuidance(item) {
  const tips = ["Use clear, well-lit reference photos with the face visible and not heavily filtered."];
  if (item.separate_photos) tips.push("Separate reference photos can be used; similar camera angles and lighting help create a more coherent composition.");
  if (item.pets_allowed) tips.push("For pets, include a sharp photo showing the eyes, coat colors, and distinctive markings.");
  if (item.memorial) tips.push("Choose a reference image that feels representative and emotionally appropriate; avoid sharing sensitive personal details that are not needed for the portrait plan.");
  return tips.join(" ");
}

function whyItFits(item) {
  if (item.memorial) return "It matches a remembrance or memorial use case and supports a respectful composition.";
  if (item.people === "family") return "It is designed for family subjects and can accommodate common family-gift scenarios.";
  if (item.people === "couple") return "It is designed around a couple and common relationship occasions.";
  if (item.people === "friends") return "It is designed around friendship and shared memories.";
  if (item.pets_allowed) return "It is designed around a pet as the main subject.";
  return "It matches the subjects and occasion described in the request.";
}

export function recommendConcepts(request, concepts, maxResults = 3) {
  const limit = Math.max(1, Math.min(3, Number(maxResults) || 3));
  return concepts
    .map((item) => ({ item, score: scoreItem(request, item) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ item }) => ({
      concept: item.concept,
      category: item.category,
      summary: item.summary,
      why_it_fits: whyItFits(item),
      photo_guidance: photoGuidance(item)
    }));
}
