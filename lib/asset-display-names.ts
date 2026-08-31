const localizedNames = new Map<string, string>([
  ["contax::t2 date back", "康泰时 T2"],
  ["contax::tvs ii", "康泰时 TVS II"],
  ["nikon::28ti", "尼康 28Ti"],
  ["rollei::35 classic titanium", "禄来 35 Classic 钛金版"],
  ["canon::autoboy s ii", "佳能 Autoboy S II / 小霹雳 S II"],
  ["canon::autoboy s", "佳能 Autoboy S / 小霹雳 S"],
]);

function normalize(value: string) {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

export function getAssetLocalizedName(brand: string, model: string) {
  return localizedNames.get(`${normalize(brand)}::${normalize(model)}`) ?? null;
}

export function getLocalizedNameFromFormalName(formalName: string) {
  const normalizedFormalName = normalize(formalName);
  for (const [key, localizedName] of localizedNames) {
    const [brand, model] = key.split("::");
    if (normalizedFormalName === `${brand} ${model}`) return localizedName;
  }
  return null;
}
