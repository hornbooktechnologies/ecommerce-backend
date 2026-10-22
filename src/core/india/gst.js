const stateCodes = Object.freeze({
  AN: "35", AP: "37", AR: "12", AS: "18", BR: "10", CH: "04", CG: "22", DN: "26",
  DL: "07", GA: "30", GJ: "24", HR: "06", HP: "02", JK: "01", JH: "20", KA: "29",
  KL: "32", LA: "38", LD: "31", MP: "23", MH: "27", MN: "14", ML: "17", MZ: "15",
  NL: "13", OD: "21", PY: "34", PB: "03", RJ: "08", SK: "11", TN: "33", TS: "36",
  TR: "16", UP: "09", UK: "05", WB: "19"
});

export function normalizeGstStateCode(value) {
  const code = String(value || "").trim().toUpperCase();
  if (/^\d{2}$/.test(code)) return code;
  return stateCodes[code] || null;
}

export function isIntraStateSupply(originStateCode, destinationStateCode) {
  const origin = normalizeGstStateCode(originStateCode);
  const destination = normalizeGstStateCode(destinationStateCode);
  return Boolean(origin && destination && origin === destination);
}
