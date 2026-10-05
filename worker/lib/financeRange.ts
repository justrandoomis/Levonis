import { badRequest } from './http';
import { dateValue } from './operations';

export type FinanceRange={from:string|null;to:string|null};
export function financeRange(query:{from?:string;to?:string;month?:string}):FinanceRange{
  if(!query.from&&!query.to&&query.month){
    if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(query.month))throw badRequest('الشهر غير صحيح');
    const from=dateValue(`${query.month}-01`),date=new Date(`${from}T00:00:00Z`);date.setUTCMonth(date.getUTCMonth()+1);date.setUTCDate(0);
    return {from,to:date.toISOString().slice(0,10)};
  }
  const from=query.from?dateValue(query.from):null,to=query.to?dateValue(query.to):null;
  if(from&&to&&from>to)throw badRequest('بداية الفترة بعد نهايتها');return {from,to};
}
export const inFinanceRangeSql=(day:string)=>`(? IS NULL OR ${day}>=?) AND (? IS NULL OR ${day}<=?)`;
export const financeRangeArgs=(range:FinanceRange)=>[range.from,range.from,range.to,range.to];
