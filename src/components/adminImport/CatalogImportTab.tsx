/**
 * The admin tab's lazy entry for «استيراد Bambu Lab»: the dashboard with the
 * admin kit's `.ap` tokens (the products screen's stylesheet, a sibling tab's
 * chunk otherwise). Kept apart so the dashboard module stays importable by the
 * node tests, which cannot load a stylesheet. The package measures fill is
 * its own module (src/components/adminImport/PackageMeasuresFill.tsx): the
 * dashboard itself only reads the import.
 */
import '../adminProducts/theme.css';
import CatalogImportDashboard from './CatalogImportDashboard';
import PackageMeasuresFill from './PackageMeasuresFill';

/** The dashboard, with the owner's «تعبئة أبعاد الشحن من بيانات الاستيراد» under its header. */
export default function CatalogImportTab() {
  return (
    <CatalogImportDashboard>
      <PackageMeasuresFill />
    </CatalogImportDashboard>
  );
}
