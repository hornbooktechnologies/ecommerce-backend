export const catalogVerticals = Object.freeze([
  { code: "GENERAL", name: "General merchandise", label: "General", hint: "Standard quantity-tracked merchandise." },
  { code: "GROCERY", name: "Grocery & fresh", label: "Grocery", hint: "Batch, expiry, substitutions, and variable-weight controls." },
  { code: "ELECTRONICS", name: "Electronics", label: "Electronics", hint: "Serial-number and warranty controls." },
  { code: "CLOTHING", name: "Clothing & apparel", label: "Clothing", hint: "Colour, size, and exchange controls." }
]);

export const catalogVerticalCodes = Object.freeze(catalogVerticals.map((item) => item.code));

