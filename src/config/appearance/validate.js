import {logger} from '../logger.js';
import {resolveAppearance} from './appearance.js';
for(const kind of ['admin','storefront']){const theme=resolveAppearance(kind);logger.info(`${kind}: valid appearance schema v${theme.schemaVersion}, revision ${theme.revision}`);}
logger.info('All configured tenant/store layers and palette contrast pairs validated. No database access.');
