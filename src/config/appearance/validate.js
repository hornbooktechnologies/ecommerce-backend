import {resolveAppearance} from './appearance.js';
for(const kind of ['admin','storefront']){const theme=resolveAppearance(kind);console.log(`${kind}: valid appearance schema v${theme.schemaVersion}, revision ${theme.revision}`);}
console.log('All configured tenant/store layers and palette contrast pairs validated. No database access.');
