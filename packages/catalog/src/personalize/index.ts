/**
 * THE PERSONALIZATION ENGINE — one pure module set for the browser (display,
 * zero round trips per tap) and the Worker (the truth). Import a module by its
 * own path (`@levonis/catalog/personalize/config`) where the bundle matters;
 * this index re-exports them all. Later lanes append their modules here,
 * add-only.
 */
export * from './types';
export * from './vocab';
export * from './parts';
export * from './canonical';
export * from './config';
export * from './spec';
export * from './price';
export * from './rules';
export * from './surface';
export * from './check';
export * from './cairoAdvances';
export * from './styles';
export * from './fit';
export * from './color';
export * from './themes';
export * from './suggest';
export * from './summary';
