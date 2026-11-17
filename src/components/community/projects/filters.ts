/**
 * The projects list's sheet filters (community UI plan C2.1), apart from the
 * lazy FilterSheet so the page can count them without downloading it.
 */
import type { PostMaterialFamily, PostPrinterBrand, PostSort } from '../../../../packages/contracts/src/communityFilters';

export interface ProjectFilterValue {
  sort: PostSort | '';
  material: PostMaterialFamily | '';
  printer: PostPrinterBrand | '';
  has_files: '1' | '';
}

export const NO_PROJECT_FILTERS: ProjectFilterValue = { sort: '', material: '', printer: '', has_files: '' };

/** How many filters are on: the dot on «تصفية». */
export function activeFilterCount(v: ProjectFilterValue): number {
  return (v.sort && v.sort !== 'newest' ? 1 : 0) + (v.material ? 1 : 0) + (v.printer ? 1 : 0) + (v.has_files ? 1 : 0);
}
