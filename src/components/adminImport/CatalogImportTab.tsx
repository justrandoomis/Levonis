/**
 * The admin tab's lazy entry for «استيراد Bambu Lab»: the dashboard with the
 * admin kit's `.ap` tokens (the products screen's stylesheet, a sibling tab's
 * chunk otherwise). Kept apart so the dashboard module stays importable by the
 * node tests, which cannot load a stylesheet.
 */
import '../adminProducts/theme.css';

export { default } from './CatalogImportDashboard';
