import type { CostRule } from './orderFinance';
import type { EmploymentStaff } from './financeEmployment';
import { nextEmploymentDay } from './financeEmployment';

export interface WageVersion {
  id:string; rule_id:string; revision:number; staff_id:string; effective_from:string;
  effective_until:string|null; follows_employment:number; snapshot:string; reason:string;
  actor_id:string; recorded_at:string;supersedes_id?:string|null;
}
export type EffectiveWageRule=CostRule&{active:number;wage_version_id?:string;change_reason?:string};
export const wageTimelineInstalled=(db:D1Database)=>db.prepare("SELECT 1 FROM sqlite_master WHERE name='finance_wage_versions'").first();
export async function wageVersions(db:D1Database,staffId?:string):Promise<WageVersion[]> {
  if(!await wageTimelineInstalled(db))return [];
  return (await db.prepare(`SELECT * FROM finance_wage_versions${staffId?' WHERE staff_id=?':''} ORDER BY rule_id,effective_from,revision`).bind(...(staffId?[staffId]:[])).all<WageVersion>()).results??[];
}
/** A floating employment baseline is initial pay, not a later pay change.
 * Moving employment past an explicit boundary cannot revive that baseline. */
export function wageBoundaries(versions:WageVersion[],staff:Pick<EmploymentStaff,'start_work_date'>){
  const superseded=new Set(versions.map(v=>v.supersedes_id).filter(Boolean));
  const current=versions.filter(v=>!superseded.has(v.id));
  const firstExplicit=new Map<string,string>();
  for(const v of current)if(!v.follows_employment){const prior=firstExplicit.get(v.rule_id);if(!prior||v.effective_from<prior)firstExplicit.set(v.rule_id,v.effective_from);}
  return current.map(v=>({v,from:v.follows_employment&&staff.start_work_date?nextEmploymentDay(staff.start_work_date):v.effective_from}))
    .filter(({v,from})=>!v.follows_employment||!firstExplicit.has(v.rule_id)||from<firstExplicit.get(v.rule_id)!);
}
/** One winning version per rule. A new boundary ends the previous version,
 * even if the newer rule is disabled or has an explicit end date. */
export function effectiveWageRules(versions:WageVersion[],staff:Pick<EmploymentStaff,'start_work_date'>,day:string):EffectiveWageRule[] {
  const selected=new Map<string,{v:WageVersion;from:string}>();
  for(const {v,from} of wageBoundaries(versions,staff)){
    if(from>day)continue;
    const prior=selected.get(v.rule_id);
    if(!prior||from>prior.from||(from===prior.from&&v.revision>prior.v.revision))selected.set(v.rule_id,{v,from});
  }
  return [...selected.values()].filter(({v})=>!v.effective_until||day<v.effective_until).map(({v,from})=>({
    ...JSON.parse(v.snapshot),effective_from:from,effective_to:v.effective_until?new Date(Date.parse(`${v.effective_until}T00:00:00Z`)-86400000).toISOString().slice(0,10):null,
    wage_version_id:v.id,change_reason:v.reason,
  }));
}
export function wageVersionStatement(db:D1Database,rule:CostRule&{created_by?:string},actor:string,reason:string,now:string,id=`wage:${rule.id}:${rule.version}`){
  return db.prepare('INSERT INTO finance_wage_versions(id,rule_id,revision,staff_id,effective_from,effective_until,follows_employment,snapshot,reason,actor_id,recorded_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
    .bind(id,rule.id,rule.version,rule.staff_id,rule.effective_from,rule.effective_to?nextEmploymentDay(rule.effective_to):null,rule.employment_effective_default??0,JSON.stringify(rule),reason,actor,now);
}
